/**
 * Tasks Tool
 * Handles task operations for Vikunja
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthManager } from '../../auth/AuthManager';
import type { VikunjaClientFactory } from '../../client/VikunjaClientFactory';
import { MCPError, ErrorCode } from '../../types';
import { getAuthManagerFromContext, hasRequestContext, setGlobalClientFactory } from '../../client';
import { logger } from '../../utils/logger';
import { storageManager } from '../../storage';
import { getEffectiveSessionId } from '../../context/requestContext';
import { relationSchema, handleRelationSubcommands } from '../tasks-relations';
import { TaskFilteringOrchestrator } from './filtering';
import type { TaskListingArgs } from './types/filters';
import { createAuthRequiredError, handleFetchError } from '../../utils/error-handler';
import { formatAorpAsMarkdown } from '../../utils/response-factory';
import { assertWriteAllowed, getToolAnnotations, withReadOnlyNote } from '../../utils/read-only';
import { percentDoneSchema } from '../../utils/percent-done';
import { strictNestedObject } from '../../utils/strict-nested-object';

// Import all operation handlers
import { createTask, getTask, updateTask, deleteTask, createTaskResponse } from './crud';
import { bulkCreateTasks, bulkUpdateTasks, bulkDeleteTasks } from './bulk-operations';
import { assignUsers, unassignUsers, listAssignees } from './assignees';
import { handleComment } from './comments';
import { addReminder, removeReminder, listReminders } from './reminders';
import { applyLabels, removeLabels, listTaskLabels } from './labels';
import { attachSchemaFields, handleAttach, type TaskAttachArgs } from './attach';
import {
  listAttachments,
  getAttachmentInfo,
  deleteAttachment,
  downloadAttachment,
  type AttachmentSubcommandArgs,
} from './attachments';
import { setTaskBucket, bulkSetTaskBucket } from './buckets';
import { setTaskPosition } from './position';
import { getTaskByIndex } from './by-index';
import { createSubtask, listSubtasks, bulkCreateSubtasks } from './subtasks';
import { duplicateTask } from './duplicate';
import { markTaskRead } from './mark-read';

/**
 * Subcommands where `id` is accepted as an alias for `parentTaskId`.
 *
 * `id` works on nearly every other `vikunja_tasks` subcommand (get, update,
 * delete, set-bucket, ...), so an agent reaching for it on `create-subtask`/
 * `bulk-create-subtasks` previously paid a full wasted round-trip: sweep
 * evidence (netadvanced/vikunja-mcp#28) shows `bulk-create-subtasks` called
 * with `id: 243` failing with "parentTaskId is required to create subtasks",
 * only succeeding on a retry with `parentTaskId: 243`. Mirrors the
 * `PROJECT_ID_ALIAS_SUBCOMMANDS` fix in `src/tools/projects/index.ts` for the
 * identical trap. If both `id` and `parentTaskId` are supplied and disagree,
 * the call is rejected outright rather than silently picking one — see the
 * alias resolution in the tool handler below.
 */
const SUBTASK_PARENT_ID_ALIAS_SUBCOMMANDS = new Set<string>([
  'create-subtask',
  'bulk-create-subtasks',
]);

/**
 * Get session-scoped storage instance.
 *
 * The session id is `(issuer,sub)`-keyed in `oidc-http` mode and falls back
 * to the original apiUrl+token-prefix derivation in `stdio` mode — see
 * `getEffectiveSessionId` (docs/OIDC-RESOURCE-SERVER.md §3d, isolation-table
 * row #3). Resolves the ALS-bound per-identity manager first (falling back
 * to the closure-captured one in `stdio` mode, where no request context is
 * ever bound) — the closure manager is never authenticated in `oidc-http`
 * mode, so calling `.getSession()` on it directly throws for every request
 * regardless of provisioning status.
 */
async function getSessionStorage(
  authManager: AuthManager,
): ReturnType<typeof storageManager.getStorage> {
  const effectiveAuthManager = hasRequestContext()
    ? await getAuthManagerFromContext()
    : authManager;
  const session = effectiveAuthManager.getSession();
  const sessionId = getEffectiveSessionId(effectiveAuthManager);
  return storageManager.getStorage(sessionId, session.userId, session.apiUrl);
}

/**
 * List tasks with optional filtering
 */
async function listTasks(
  args: TaskListingArgs,
  storage: Awaited<ReturnType<typeof storageManager.getStorage>>,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    // Execute the complete filtering workflow using the orchestrator.
    // authManager is threaded through for cross-project listing's
    // direct-REST GET /tasks strategy (RestCrossProjectFilteringStrategy).
    const filteringResult = await TaskFilteringOrchestrator.executeTaskFiltering(
      args,
      storage,
      {},
      authManager,
    );

    // Determine filtering method message
    let filteringMessage = '';
    if (args.filter) {
      if (filteringResult.metadata?.serverSideFilteringUsed) {
        filteringMessage = ' (filtered server-side)';
      } else if (filteringResult.metadata?.serverSideFilteringAttempted) {
        filteringMessage = ' (filtered client-side - server-side fallback)';
      } else {
        filteringMessage = ' (filtered client-side)';
      }
    }

    // A result that is knowingly incomplete or a filter that could only be
    // partially honoured must be visible in the SUMMARY LINE, not only in the
    // metadata block — the whole point of issues #225/#227 is that a caller
    // could not tell "nothing matched" from "the answer is wrong/partial".
    const resultWarnings = filteringResult.metadata?.warnings ?? [];
    const incomplete = filteringResult.metadata?.resultComplete === false;
    const reliabilityMessage =
      incomplete || resultWarnings.length > 0
        ? ` — ${incomplete ? 'INCOMPLETE RESULT' : 'PARTIAL FILTER'}: ${resultWarnings.join(' ')}`
        : '';

    // orderBy/filterTimezone/filterIncludeNulls are GET /tasks query params
    // only honored by the cross-project direct-REST path
    // (RestCrossProjectFilteringStrategy) — single-project listing calls
    // GET /projects/{id}/tasks, and these three were never part of the
    // params shape those call sites used (see the schema comment above
    // these fields). Supplying one on a single-project listing used to be
    // silently accepted and silently ignored, with no signal at all (issue
    // #290 LOW-3).
    //
    // `expand` used to be in this list and is NOT any more (#184 P3 step
    // 7). It was grouped with the other three on the assumption that
    // GET /projects/{id}/tasks did not accept it. Live probing of 2.4.0,
    // 2.5.0 and 2.6.0 on 2026-09-05 showed it accepts it on all three and
    // populates the expanded fields, so it is now forwarded on the
    // single-project path instead of reported as ignored.
    const isCrossProjectListing = args.projectId === undefined || args.allProjects === true;
    const ignoredParams: string[] = [];
    if (!isCrossProjectListing) {
      if (args.orderBy !== undefined) ignoredParams.push('orderBy');
      if (args.filterTimezone !== undefined) ignoredParams.push('filterTimezone');
      if (args.filterIncludeNulls !== undefined) ignoredParams.push('filterIncludeNulls');
    }
    const ignoredParamsMessage =
      ignoredParams.length > 0
        ? ` — NOTE: ${ignoredParams.join(', ')} ${ignoredParams.length === 1 ? 'is' : 'are'} ` +
          'ignored on this single-project listing (only honored for cross-project listing — ' +
          'omit projectId or pass allProjects: true).'
        : '';

    const taskCount = filteringResult.tasks?.length || 0;
    const response = createTaskResponse(
      'list-tasks',
      `Found ${taskCount} tasks${filteringMessage}${reliabilityMessage}${ignoredParamsMessage}`,
      { tasks: filteringResult.tasks || [] },
      {
        timestamp: new Date().toISOString(),
        count: taskCount,
        ...(filteringResult.metadata || {}),
        ...(ignoredParams.length > 0 ? { ignoredParams } : {}),
      },
      undefined, // verbosity (ignored - using standard AORP)
      undefined, // useOptimizedFormat (ignored - using standard AORP)
      undefined, // useAorp (ignored - always using AORP)
      undefined, // aorpConfig (using auto-generated)
      args.sessionId,
    );

    logger.debug('Tasks tool response', { subcommand: 'list', itemCount: taskCount });

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(response.response),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }

    // Log the full error for debugging filter issues
    logger.error('Task list error:', {
      error: error instanceof Error ? error.message : String(error),
      filter: args.filter,
      filterId: args.filterId,
    });

    throw handleFetchError(error, 'list tasks');
  }
}

export function registerTasksTool(
  server: McpServer,
  authManager: AuthManager,
  clientFactory?: VikunjaClientFactory,
): void {
  server.tool(
    'vikunja_tasks',
    withReadOnlyNote(
      'vikunja_tasks',
      'Manage tasks with comprehensive operations (create, update, delete, list, assign, attach/list/delete files, comment, bulk operations, set Kanban bucket, bulk set Kanban bucket, set position, lookup by per-project index, create/list subtasks, bulk create subtasks, duplicate, mark-read). ' +
        'download-attachment cannot deliver file bytes through MCP (no binary channel) — it returns the direct download URL and auth guidance instead. ' +
        'create-subtask is a composite (resolve parent -> create task -> relate -> verify) with opt-in atomic rollback via `atomic: true` (default best-effort — see docs/ENDPOINT-PLAYBOOK.md §5). ' +
        'create-subtask/bulk-create-subtasks identify the parent via `parentTaskId` — `id` is accepted as an alias for it on these two subcommands (supplying both and disagreeing is rejected). ' +
        'bulk-create-subtasks creates several subtasks under the same parent in one call (resolves the parent once, then creates/relates each sequentially, per-subtask atomic rollback, honest partial reporting of which subtasks were created/related/failed). ' +
        'bulk-set-bucket moves several tasks into the same Kanban bucket in one call (resolves the project/view once, then applies each move sequentially, honest partial reporting of failedIds). ' +
        'set-bucket/bulk-set-bucket use FOUR distinct ids: `id`/`taskIds` (the task(s) being moved, from vikunja_tasks list/get), `bucketId` (the destination Kanban bucket, from vikunja_projects list-buckets), `viewId` (the Kanban view, auto-resolved when omitted), and the optional `projectId` override — see each field description for exactly which id it expects. ' +
        'duplicate copies a task (labels, assignees, attachments, reminders) into the same project (PUT /tasks/{taskID}/duplicate, no body). ' +
        'mark-read removes the current unread status entry for a task (POST /tasks/{projecttask}/read).',
    ),
    {
      subcommand: z.enum([
        'create',
        'get',
        'update',
        'delete',
        'list',
        'assign',
        'unassign',
        'list-assignees',
        'attach',
        'list-attachments',
        'get-attachment-info',
        'delete-attachment',
        'download-attachment',
        'comment',
        'bulk-create',
        'bulk-update',
        'bulk-delete',
        'relate',
        'unrelate',
        'relations',
        'add-reminder',
        'remove-reminder',
        'list-reminders',
        'apply-label',
        'remove-label',
        'list-labels',
        'set-bucket',
        'bulk-set-bucket',
        'set-position',
        'get-by-index',
        'create-subtask',
        'bulk-create-subtasks',
        'list-subtasks',
        'duplicate',
        'mark-read',
      ]),
      // Task creation/update fields
      title: z.string().optional(),
      description: z.string().optional(),
      projectId: z
        .number()
        .optional()
        .describe(
          'The project id, used by create/list/etc. to scope the task(s). On set-bucket/' +
            'bulk-set-bucket this is optional and only needed to override auto-resolution ' +
            '(normally resolved from the task itself); it is NOT the bucket id.',
        ),
      dueDate: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      priority: z.number().min(0).max(5).optional(),
      // percentDone is a WHOLE PERCENTAGE 0-100 on this tool surface. Vikunja's
      // wire contract really is a fraction 0-1 (`PercentDone float64`,
      // pkg/models/tasks.go; the frontend picker stores [0, 0.1, ... 1] in
      // PercentDoneSelect.vue and every display site renders `percentDone * 100`)
      // — that conversion happens in src/utils/percent-done.ts, on the way to and
      // from the API, and nowhere else. The fraction is a transport detail and is
      // deliberately not part of the contract an agent has to learn: it leaked as
      // a memorized "gotcha", Vikunja's own human-facing scale is 0-100, and
      // integers make `percentDone: 1` unambiguously 1% instead of a silent
      // "done". See decision 22 in docs/ROADMAP.md §3 for the full reasoning and
      // its revisit condition; the two community PRs that assumed 0-100
      // (democratize-technology/vikunja-mcp#94, #82) read the interface the same
      // way this schema now does.
      percentDone: percentDoneSchema.describe(
        'Completion progress as a whole percentage between 0 and 100 (25 = 25%, 100 = done). ' +
          'Must be an integer — 0.5 is rejected, not silently read as half a percent. ' +
          'Accepted by create, update, bulk-create, create-subtask and bulk-create-subtasks.',
      ),
      // models.Task.hex_color — a real create AND update field (Vikunja's
      // createTask normalizes and inserts it; hex_color is in the update
      // path's column allowlist). batch-import has always accepted a per-task
      // hexColor, so leaving it undeclared here meant the same field worked in
      // one entry point and silently vanished in another. '' clears the color.
      hexColor: z
        .string()
        .regex(
          /^(#[0-9A-Fa-f]{6})?$/,
          "hexColor must be #RRGGBB (e.g. #4287f5), or '' to clear the task color",
        )
        .optional()
        .describe(
          "Task color as #RRGGBB (e.g. #4287f5), or '' to clear it. Accepted by create and " +
            'update. Not a per-task field on bulk-create/bulk-create-subtasks — create the ' +
            'tasks, then update.',
        ),
      labels: z.array(z.number()).optional(),
      assignees: z.array(z.number()).optional(),
      // apply-label only: label titles to get-or-create-then-attach, merged
      // with `labels` (deduped) — the same field vikunja_task_labels declares
      // and the same one applyLabels has always read. Undeclared here, Zod
      // stripped it: a call passing BOTH labels and labelTitles silently lost
      // the titles, and a titles-only call failed with a message insisting no
      // titles had been given. See src/utils/label-ensure.ts.
      labelTitles: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'apply-label only: label titles to attach by name. Each title is get-or-created and ' +
            'attached in ONE call (no separate lookup), merged with any ids in `labels`. ' +
            'remove-label takes ids only.',
        ),
      // Kanban bucket fields (set-bucket, bulk-set-bucket subcommands).
      // z.coerce tolerates MCP clients whose cached tool schema predates
      // these params and therefore send them as strings over JSON-RPC.
      bucketId: z.coerce
        .number()
        .optional()
        .describe(
          'The destination Kanban bucket (column) id for set-bucket/bulk-set-bucket — e.g. ' +
            'the id of the "Doing" column. Get it from vikunja_projects list-buckets, NOT from ' +
            'this tool. This is a bucket id, not a project or view id.',
        ),
      viewId: z.coerce
        .number()
        .optional()
        .describe(
          'Optional Kanban view id for set-bucket/bulk-set-bucket, auto-resolved from the ' +
            "task's project when omitted. Get an explicit value from vikunja_projects " +
            "list-views (look for viewKind: 'kanban'). This is a view id, not a bucket id.",
        ),
      // Task position fields (set-position subcommand). position is a
      // float64 per the API (see models.TaskPosition) - see docs on
      // spreading tasks between two positions - so it is not coerced to an
      // integer. projectViewId is auto-resolved from projectId + viewKind
      // when omitted, mirroring set-bucket's resolve-by-name friendliness.
      position: z.coerce.number().optional(),
      projectViewId: z.coerce.number().optional(),
      viewKind: z.enum(['list', 'gantt', 'table', 'kanban']).optional(),
      // By-index lookup field (get-by-index subcommand): the task's
      // human-facing per-project index (e.g. the "42" in "PROJ-42").
      index: z.coerce.number().optional(),
      // Recurring task fields
      repeatAfter: z.number().min(0).optional(),
      repeatMode: z.enum(['day', 'week', 'month', 'year']).optional(),
      // Query fields
      id: z
        .number()
        .optional()
        .describe(
          'The task id, used by most subcommands (get, update, delete, set-bucket, etc.) to ' +
            'identify the target task. On set-bucket this is the task to move — NOT the ' +
            'bucket id (use bucketId for that) or a project id. bulk-set-bucket moves several ' +
            'tasks at once and uses the separate taskIds array instead of id. On ' +
            'create-subtask/bulk-create-subtasks, `id` is accepted as an alias for ' +
            '`parentTaskId` (the parent task) — see parentTaskId.',
        ),
      filter: z
        .string()
        .optional()
        .describe(
          'Filter query string. Operators: = != > >= < <= like in "not in". Combine ' +
            'conditions with && (AND) or || (OR); group with parentheses. Examples: ' +
            '"priority >= 4" (high priority, priority is 0-5, so >= 4 means urgent/DO NOW); ' +
            '"dueDate < now+14d" (due within 14 days); "priority >= 4 && dueDate < now+7d" ' +
            "(high priority AND due soon); \"labels in 'bug', 'urgent'\" (has either label); " +
            '"done = false && dueDate <= now" (overdue, not done). Date literals: now, ' +
            'now+14d, now-1w, or ISO 8601 (2024-12-31). percentDone in a filter uses the ' +
            'same whole-percentage 0-100 scale as the percentDone argument above, so ' +
            '"percentDone > 50" means more than half done. Fields use camelCase (dueDate, ' +
            'percentDone, startDate, endDate, doneAt, project, plus ' +
            'done/priority/assignees/labels/created/updated/title/description); ' +
            'snake_case aliases (due_date, percent_done, etc.) are also accepted and ' +
            'normalized automatically. Build one with vikunja_filters build/validate.',
        ),
      filterId: z.string().optional(),
      page: z.number().optional(),
      perPage: z.number().optional(),
      sort: z.string().optional(),
      search: z.string().optional(),
      // List specific filters
      allProjects: z.boolean().optional(),
      // Dual-purpose: a completion filter on `list`, and the task's done state
      // on create/update. create declared it and never sent it, so "create
      // this task, already done" silently created an open task.
      done: z
        .boolean()
        .optional()
        .describe(
          'On create/update: whether the task is done. On list: filters by completion state. ' +
            'Note that a task created with done: true has no done_at timestamp (Vikunja only ' +
            'stamps done_at when a task is UPDATED to done), so it will not match doneAt ' +
            'filters — create it open and update it to done if you need that timestamp.',
        ),
      // GET /tasks query params honored for cross-project listing (direct
      // REST — see RestCrossProjectFilteringStrategy). Single-project
      // listing (ClientSideFilteringStrategy/ServerSideFilteringStrategy)
      // calls GET /projects/{id}/tasks, which never supported these extra
      // params, so they are unused in that case — and SAID to be unused,
      // via the ignoredParams note the list handler renders.
      //
      // `expand` below is the exception: it is honored on both listing
      // shapes since #184 P3 step 7.
      orderBy: z
        .enum(['asc', 'desc'])
        .optional()
        .describe(
          'Sort direction paired with sort_by. Cross-project listing only (no projectId, or ' +
            'allProjects: true) — ignored (with a response warning) on a single-project listing.',
        ),
      filterTimezone: z
        .string()
        .optional()
        .describe(
          'Timezone for filter date literals. Cross-project listing only (no projectId, or ' +
            'allProjects: true) — ignored (with a response warning) on a single-project listing.',
        ),
      filterIncludeNulls: z
        .boolean()
        .optional()
        .describe(
          'Whether filtered fields with a null value should be included. Cross-project ' +
            'listing only (no projectId, or allProjects: true) — ignored (with a response ' +
            'warning) on a single-project listing.',
        ),
      expand: z
        .array(z.enum(['subtasks', 'buckets', 'reactions', 'comments']))
        .optional()
        .describe(
          'Extra relations to embed in each task. Honored on both cross-project and ' +
            'single-project listings. With a tk_* API token, expand=comments and ' +
            'expand=reactions additionally need the tasks_comments / reactions token scopes ' +
            'from Vikunja 2.6.0 on; without them the call fails with a 401 rather than ' +
            'quietly returning unexpanded tasks.',
        ),
      // Comment fields
      comment: z.string().optional(),
      commentId: z.number().optional(),
      // Bulk operation fields
      taskIds: z
        .array(z.number())
        .optional()
        .describe(
          'Task ids for bulk operations (bulk-update, bulk-delete, bulk-set-bucket). On ' +
            'bulk-set-bucket these are the tasks to move into the single bucket named by ' +
            'bucketId.',
        ),
      field: z.string().optional(),
      value: z.unknown().optional(),
      tasks: z
        .array(
          // strict: an undeclared key here used to be stripped silently, so a
          // per-task field an agent invented (or reached for from the flat
          // create shape) vanished while the call still reported success. See
          // src/utils/strict-nested-object.ts.
          strictNestedObject(
            {
              title: z.string(),
              description: z.string().optional(),
              dueDate: z.string().optional(),
              startDate: z.string().optional(),
              endDate: z.string().optional(),
              priority: z.number().min(0).max(5).optional(),
              // Whole percentage 0-100, same contract as the top-level
              // percentDone above (converted to Vikunja's 0-1 wire fraction in
              // createOneBulkTask).
              percentDone: percentDoneSchema,
              labels: z.array(z.number()).optional(),
              assignees: z.array(z.number()).optional(),
              repeatAfter: z.number().min(0).optional(),
              repeatMode: z.enum(['day', 'week', 'month', 'year']).optional(),
            },
            'a bulk-create task',
            'projectId is a TOP-LEVEL argument, not a per-task one. Fields with no bulk-create ' +
              'equivalent (done, hexColor, position, bucketId) belong on the single-task ' +
              'subcommands — bulk-create the tasks, then use update / set-bucket / set-position ' +
              '(or bulk-update / bulk-set-bucket).',
          ),
        )
        .optional(),
      // Reminder fields
      reminderDate: z.string().optional(),
      // Vikunja's API has no reminder id — remove-reminder identifies the
      // reminder to remove by its reminderDate string and/or its zero-based
      // reminderIndex, both shown by list-reminders.
      reminderIndex: z.number().optional(),
      // Attach subcommand fields (filePath, fileContent, filename)
      ...attachSchemaFields,
      // Attachments read-side fields (list-attachments, get-attachment-info,
      // delete-attachment, download-attachment). page/perPage are shared
      // with the generic query fields above.
      attachmentId: z.number().optional(),
      previewSize: z.enum(['sm', 'md', 'lg', 'xl']).optional(),
      // Add relation schema
      ...relationSchema,
      // Subtask composite fields (create-subtask, bulk-create-subtasks).
      // title/description/dueDate/priority/labels/assignees/bucketId are
      // shared with the generic create/set-bucket fields above.
      parentTaskId: z
        .number()
        .optional()
        .describe(
          'The parent task id for create-subtask/bulk-create-subtasks — the existing task the ' +
            'new subtask(s) attach to. `id` is accepted as an alias for `parentTaskId` on these ' +
            'two subcommands. Supplying both `id` and `parentTaskId` with different values is ' +
            'rejected as a validation error.',
        ),
      // Opt into atomic rollback for create-subtask / bulk-create-subtasks
      // (default best-effort; bulk-create-subtasks applies it PER SUBTASK,
      // never across the batch) — see docs/ENDPOINT-PLAYBOOK.md §5.
      atomic: z.boolean().optional(),
      // bulk-create-subtasks: array of subtask specs, same per-item shape as
      // create-subtask's own fields.
      subtasks: z
        .array(
          strictNestedObject(
            {
              title: z.string(),
              description: z.string().optional(),
              dueDate: z.string().optional(),
              startDate: z.string().optional(),
              endDate: z.string().optional(),
              priority: z.number().min(0).max(5).optional(),
              // Whole percentage 0-100, same contract as the top-level
              // percentDone above (converted to Vikunja's 0-1 wire fraction by
              // the shared percentDoneToFraction in src/utils/percent-done.ts).
              percentDone: percentDoneSchema,
              labels: z.array(z.number()).optional(),
              assignees: z.array(z.number()).optional(),
              bucketId: z.coerce.number().optional(),
            },
            'a bulk-create-subtasks subtask',
            'parentTaskId is a TOP-LEVEL argument, not a per-subtask one. Anything else ' +
              '(done, hexColor, repeatAfter, position) belongs on the single-task ' +
              'subcommands — create the subtasks, then use update / set-position.',
          ),
        )
        .optional(),
      // Session ID for AORP response tracking
      sessionId: z.string().optional(),
    },
    getToolAnnotations('vikunja_tasks'),
    async (rawArgs) => {
      // Ergonomic id/parentTaskId alias for create-subtask/bulk-create-subtasks
      // — see SUBTASK_PARENT_ID_ALIAS_SUBCOMMANDS above (the same trap already
      // solved for projects via PROJECT_ID_ALIAS_SUBCOMMANDS). Precedence is
      // explicit: if both are supplied and disagree, reject rather than
      // silently picking one.
      if (
        SUBTASK_PARENT_ID_ALIAS_SUBCOMMANDS.has(rawArgs.subcommand) &&
        rawArgs.id !== undefined &&
        rawArgs.id !== null &&
        rawArgs.parentTaskId !== undefined &&
        rawArgs.parentTaskId !== null &&
        rawArgs.id !== rawArgs.parentTaskId
      ) {
        throw new MCPError(
          ErrorCode.VALIDATION_ERROR,
          `id (${rawArgs.id}) and parentTaskId (${rawArgs.parentTaskId}) were both supplied and ` +
            `disagree for ${rawArgs.subcommand} — provide only one, or make them match.`,
        );
      }
      const args =
        SUBTASK_PARENT_ID_ALIAS_SUBCOMMANDS.has(rawArgs.subcommand) &&
        (rawArgs.parentTaskId === undefined || rawArgs.parentTaskId === null) &&
        rawArgs.id !== undefined &&
        rawArgs.id !== null
          ? { ...rawArgs, parentTaskId: rawArgs.id }
          : rawArgs;
      try {
        logger.debug('Executing tasks tool', { subcommand: args.subcommand, args });

        // Check authentication with enhanced error message
        // (closure-gate precedence fix: defer to the per-request context
        // when bound — see hasRequestContext's doc comment, src/client.ts)
        if (hasRequestContext()) {
          await getAuthManagerFromContext();
        } else if (!authManager.isAuthenticated()) {
          throw createAuthRequiredError('access task management features');
        }

        // Global read-only safety mode gate. 'comment' is dual-purpose
        // (creates a comment when text is supplied, otherwise lists
        // comments — see handleComment) so its effective classification
        // depends on whether `comment` text was actually provided.
        assertWriteAllowed(
          'vikunja_tasks',
          args.subcommand,
          args.subcommand === 'comment' ? (args.comment ? 'write' : 'read') : undefined,
        );

        // Set the client factory for this request if provided
        if (clientFactory) {
          await setGlobalClientFactory(clientFactory);
        }

        // Test client connection
        await getAuthManagerFromContext();

        switch (args.subcommand) {
          case 'list': {
            // Get session-scoped storage for filter operations (only when needed)
            const storage = await getSessionStorage(authManager);
            return listTasks(args as Parameters<typeof listTasks>[0], storage, authManager);
          }

          case 'create':
            return createTask(args as Parameters<typeof createTask>[0], authManager);

          case 'get':
            return getTask(args as Parameters<typeof getTask>[0], authManager);

          case 'update':
            return updateTask(args as Parameters<typeof updateTask>[0], authManager);

          case 'delete':
            return deleteTask(args as Parameters<typeof deleteTask>[0], authManager);

          case 'assign':
            return assignUsers(args as Parameters<typeof assignUsers>[0], authManager);

          case 'unassign':
            return unassignUsers(args as Parameters<typeof unassignUsers>[0], authManager);

          case 'list-assignees':
            return listAssignees(args as Parameters<typeof listAssignees>[0], authManager);

          case 'comment':
            return handleComment(args, authManager);

          case 'attach':
            return handleAttach(args as TaskAttachArgs, authManager);

          case 'list-attachments':
            return listAttachments(args as AttachmentSubcommandArgs, authManager);

          case 'get-attachment-info':
            return getAttachmentInfo(args as AttachmentSubcommandArgs, authManager);

          case 'delete-attachment':
            return deleteAttachment(args as AttachmentSubcommandArgs, authManager);

          case 'download-attachment':
            return downloadAttachment(args as AttachmentSubcommandArgs, authManager);

          case 'bulk-update':
            return bulkUpdateTasks(args as Parameters<typeof bulkUpdateTasks>[0], authManager);

          case 'bulk-delete':
            return bulkDeleteTasks(args as Parameters<typeof bulkDeleteTasks>[0], authManager);

          case 'bulk-create':
            return bulkCreateTasks(args as Parameters<typeof bulkCreateTasks>[0], authManager);

          // Handle relation subcommands
          case 'relate':
          case 'unrelate':
          case 'relations':
            return handleRelationSubcommands(
              {
                subcommand: args.subcommand,
                id: args.id,
                otherTaskId: args.otherTaskId,
                relationKind: args.relationKind,
              },
              authManager,
            );

          // Handle reminder operations
          case 'add-reminder':
            return addReminder(args as Parameters<typeof addReminder>[0], authManager);

          case 'remove-reminder':
            return removeReminder(args, authManager);

          case 'list-reminders':
            return listReminders(args as Parameters<typeof listReminders>[0], authManager);
          case 'apply-label':
            return applyLabels(args, authManager);

          case 'remove-label':
            // `labelTitles` is an apply-label-only field: removeLabels only
            // ever reads ids. Now that the flat schema declares labelTitles,
            // an agent that learned it from apply-label would otherwise have
            // its titles silently ignored here — reject instead, naming the
            // field and the way to do what it wanted (the same treatment
            // `position` gets on create).
            if (args.labelTitles !== undefined && args.labelTitles.length > 0) {
              throw new MCPError(
                ErrorCode.VALIDATION_ERROR,
                'labelTitles is not supported by remove-label — removal takes label ids only, ' +
                  'so a title here would be silently ignored. Look the ids up with ' +
                  'list-labels (or vikunja_labels list) and pass them as `labels`.',
              );
            }
            return removeLabels(args, authManager);

          case 'list-labels':
            return listTaskLabels(args, authManager);

          case 'set-bucket':
            return setTaskBucket(args as Parameters<typeof setTaskBucket>[0], authManager);

          case 'bulk-set-bucket':
            return bulkSetTaskBucket(args as Parameters<typeof bulkSetTaskBucket>[0], authManager);

          case 'set-position':
            return setTaskPosition(args as Parameters<typeof setTaskPosition>[0], authManager);

          case 'get-by-index':
            return getTaskByIndex(args as Parameters<typeof getTaskByIndex>[0], authManager);

          case 'create-subtask':
            return createSubtask(args as Parameters<typeof createSubtask>[0], authManager);

          case 'bulk-create-subtasks':
            return bulkCreateSubtasks(
              args as Parameters<typeof bulkCreateSubtasks>[0],
              authManager,
            );

          case 'list-subtasks':
            return listSubtasks(args as Parameters<typeof listSubtasks>[0], authManager);

          case 'duplicate':
            return duplicateTask(args as Parameters<typeof duplicateTask>[0], authManager);

          case 'mark-read':
            return markTaskRead(args as Parameters<typeof markTaskRead>[0], authManager);

          default:
            throw new MCPError(
              ErrorCode.VALIDATION_ERROR,
              `Unknown subcommand: ${args.subcommand as string}`,
            );
        }
      } catch (error) {
        if (error instanceof MCPError) {
          throw error;
        }
        throw new MCPError(
          ErrorCode.INTERNAL_ERROR,
          `Task operation error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
