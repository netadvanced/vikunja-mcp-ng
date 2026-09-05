/**
 * Verification engine ("DID IT WORK"): executes a scenario's `verify` spec
 * against the live Vikunja REST API via `RestClient`. Never trusts the
 * agent's own transcript/self-report -- every check here is an independent
 * REST read, exactly like a human re-opening the Vikunja UI to check an
 * agent's claimed work.
 *
 * Vikunja represents "no due date" as the epoch sentinel
 * `0001-01-01T00:00:00Z`, not `null` (confirmed against a live 2.3.0 stack
 * while building this harness) -- `hasRealDueDate` below is the only place
 * that sentinel needs to be known.
 */

import type { CheckVerdict, Scenario, VerifyCheck, VerificationVerdict } from '../types';
import type {
  VikunjaProject,
  VikunjaRestClient,
  VikunjaTask,
  VikunjaTeam,
} from './rest-client';

const NO_DUE_DATE_SENTINEL = '0001-01-01T00:00:00Z';

function hasRealDueDate(task: VikunjaTask): boolean {
  return Boolean(task.due_date) && task.due_date !== NO_DUE_DATE_SENTINEL;
}

async function findProject(client: VikunjaRestClient, titleContains: string): Promise<VikunjaProject | undefined> {
  const projects = await client.listProjects();
  return projects.find((p) => p.title.includes(titleContains));
}

/** Teams are matched on `name` -- `models.Team` has no `title` field. */
async function findTeam(
  client: VikunjaRestClient,
  nameContains: string,
): Promise<VikunjaTeam | undefined> {
  const teams = await client.listTeams();
  return teams.find((t) => t.name.includes(nameContains));
}

function fieldMatches(
  task: VikunjaTask,
  field: 'priority' | 'done' | 'due_date' | 'percent_done',
  op: 'gte' | 'eq' | 'set',
  value: number | boolean | undefined,
): boolean {
  switch (field) {
    case 'priority':
    case 'percent_done': {
      const actual = task[field] ?? 0;
      if (op === 'set') return actual > 0;
      if (typeof value !== 'number') return false;
      return op === 'gte' ? actual >= value : actual === value;
    }
    case 'done': {
      if (op === 'set') return task.done === true;
      return task.done === Boolean(value);
    }
    case 'due_date': {
      // "gte"/"eq" on a due date isn't meaningful without a richer date
      // check type -- scenarios needing a date range use
      // "tasks-due-date-in-range" instead. "set" is the only supported op
      // here (mirrored by the zod schema not requiring `value` for it).
      return hasRealDueDate(task);
    }
    default:
      return false;
  }
}

async function runCheck(client: VikunjaRestClient, check: VerifyCheck): Promise<CheckVerdict> {
  switch (check.type) {
    case 'project-exists': {
      const project = await findProject(client, check.titleContains);
      return {
        check,
        passed: Boolean(project),
        detail: project
          ? `found project "${project.title}" (id ${project.id})`
          : `no project with title containing "${check.titleContains}"`,
      };
    }

    case 'min-tasks-in-project': {
      const project = await findProject(client, check.projectTitleContains);
      if (!project) {
        return { check, passed: false, detail: `no project with title containing "${check.projectTitleContains}"` };
      }
      const tasks = await client.listTasksInProject(project.id);
      return {
        check,
        passed: tasks.length >= check.min,
        detail: `project "${project.title}" has ${tasks.length} task(s), need >= ${check.min}`,
      };
    }

    case 'min-buckets-in-project': {
      const project = await findProject(client, check.projectTitleContains);
      if (!project) {
        return { check, passed: false, detail: `no project with title containing "${check.projectTitleContains}"` };
      }
      const buckets = await client.listBuckets(project.id);
      return {
        check,
        passed: buckets.length >= check.min,
        detail: `project "${project.title}" has ${buckets.length} bucket(s) (${buckets.map((b) => b.title).join(', ') || 'none'}), need >= ${check.min}`,
      };
    }

    case 'buckets-with-tasks-count': {
      const project = await findProject(client, check.projectTitleContains);
      if (!project) {
        return { check, passed: false, detail: `no project with title containing "${check.projectTitleContains}"` };
      }
      const buckets = await client.listBuckets(project.id);
      const nonEmpty = buckets.filter((b) => (b.count ?? 0) > 0);
      return {
        check,
        passed: nonEmpty.length >= check.min,
        detail:
          `${nonEmpty.length}/${buckets.length} bucket(s) in "${project.title}" hold at least one task ` +
          `(${buckets.map((b) => `${b.title}: ${b.count ?? 0}`).join(', ') || 'none'}), need >= ${check.min}`,
      };
    }

    case 'tasks-field-match-count': {
      const project = await findProject(client, check.projectTitleContains);
      if (!project) {
        return { check, passed: false, detail: `no project with title containing "${check.projectTitleContains}"` };
      }
      const tasks = await client.listTasksInProject(project.id);
      const matching = tasks.filter((t) => fieldMatches(t, check.field, check.op, check.value));
      return {
        check,
        passed: matching.length >= check.min,
        detail:
          `${matching.length}/${tasks.length} task(s) in "${project.title}" match ` +
          `${check.field} ${check.op}${check.value !== undefined ? ` ${String(check.value)}` : ''}, need >= ${check.min}`,
      };
    }

    case 'tasks-due-date-in-range': {
      const project = await findProject(client, check.projectTitleContains);
      if (!project) {
        return { check, passed: false, detail: `no project with title containing "${check.projectTitleContains}"` };
      }
      const start = new Date(check.startDate).getTime();
      const end = new Date(check.endDate).getTime();
      const tasks = await client.listTasksInProject(project.id);
      const matching = tasks.filter((t) => {
        if (!hasRealDueDate(t) || !t.due_date) return false;
        const due = new Date(t.due_date).getTime();
        return due >= start && due <= end;
      });
      return {
        check,
        passed: matching.length >= check.min,
        detail:
          `${matching.length}/${tasks.length} task(s) in "${project.title}" have a due date in ` +
          `[${check.startDate}, ${check.endDate}], need >= ${check.min}`,
      };
    }

    case 'label-exists': {
      const labels = await client.listLabels();
      const label = labels.find((l) => l.title.includes(check.titleContains));
      return {
        check,
        passed: Boolean(label),
        detail: label ? `found label "${label.title}" (id ${label.id})` : `no label with title containing "${check.titleContains}"`,
      };
    }

    case 'tasks-with-label-count': {
      const project = await findProject(client, check.projectTitleContains);
      if (!project) {
        return { check, passed: false, detail: `no project with title containing "${check.projectTitleContains}"` };
      }
      const tasks = await client.listTasksInProject(project.id);
      let matching = 0;
      for (const task of tasks) {
        const labels = await client.requestOrEmpty<{ id: number; title: string }>(`/tasks/${task.id}/labels`);
        if (labels.some((l) => l.title.includes(check.labelTitleContains))) matching += 1;
      }
      const withinMax = check.max === undefined || matching <= check.max;
      return {
        check,
        passed: matching >= check.min && withinMax,
        detail:
          `${matching}/${tasks.length} task(s) in "${project.title}" carry a label containing ` +
          `"${check.labelTitleContains}", need >= ${check.min}` +
          (check.max !== undefined ? ` and <= ${check.max}` : ''),
      };
    }

    case 'task-has-subtasks': {
      const project = await findProject(client, check.projectTitleContains);
      if (!project) {
        return { check, passed: false, detail: `no project with title containing "${check.projectTitleContains}"` };
      }
      const tasks = await client.listTasksInProject(project.id);
      const parent = tasks.find((t) => t.title.includes(check.parentTitleContains));
      if (!parent) {
        return {
          check,
          passed: false,
          detail: `no task in "${project.title}" with title containing "${check.parentTitleContains}"`,
        };
      }
      const full = await client.getTask(parent.id);
      const subtasks = full.related_tasks?.subtask ?? [];
      return {
        check,
        passed: subtasks.length >= check.min,
        detail: `task "${parent.title}" (id ${parent.id}) has ${subtasks.length} subtask(s), need >= ${check.min}`,
      };
    }

    case 'task-absent-from-project': {
      const project = await findProject(client, check.projectTitleContains);
      if (!project) {
        // No project at all means no task inside it either -- the asserted
        // absence holds, and failing here would only mask the separate
        // project-exists check that is the real diagnostic.
        return {
          check,
          passed: true,
          detail:
            `no project with title containing "${check.projectTitleContains}" ` +
            `(absence holds vacuously)`,
        };
      }
      const tasks = await client.listTasksInProject(project.id);
      const offenders = tasks.filter((t) => t.title.includes(check.titleContains));
      return {
        check,
        passed: offenders.length === 0,
        detail:
          offenders.length === 0
            ? `no task in "${project.title}" has a title containing "${check.titleContains}"`
            : `${offenders.length} task(s) in "${project.title}" match "${check.titleContains}": ` +
              offenders.map((t) => `"${t.title}" (id ${t.id})`).join(', '),
      };
    }

    case 'task-first-in-list-view': {
      const project = await findProject(client, check.projectTitleContains);
      if (!project) {
        return {
          check,
          passed: false,
          detail: `no project with title containing "${check.projectTitleContains}"`,
        };
      }
      const tasks = await client.listListViewTasks(project.id);
      const first = tasks[0];
      const observed = tasks.map((t) => `${t.title}@${t.position ?? '?'}`).join(', ');
      return {
        check,
        passed: Boolean(first?.title.includes(check.titleContains)),
        detail:
          `list-view order in "${project.title}": [${observed || 'none'}], ` +
          `expected the first entry to contain "${check.titleContains}"`,
      };
    }

    case 'team-exists': {
      const team = await findTeam(client, check.nameContains);
      if (!team) {
        return {
          check,
          passed: false,
          detail: `no team with name containing "${check.nameContains}"`,
        };
      }
      const details: string[] = [
        `found team "${team.name}" (id ${team.id}, is_public ${String(team.is_public)})`,
      ];
      let passed = true;

      if (check.isPublic !== undefined) {
        // Compared against the RAW `is_public` the server stores: this is the
        // assertion that fails if a partial team update ever stops merging
        // over the current model (src/tools/teams.ts).
        const actual = team.is_public === true;
        if (actual !== check.isPublic) passed = false;
        details.push(`is_public is ${String(actual)}, expected ${String(check.isPublic)}`);
      }

      if (check.hasMemberUsername !== undefined) {
        const members = team.members ?? [];
        const member = members.find((m) => m.username === check.hasMemberUsername);
        if (!member) passed = false;
        const roster = members.map((m) => `${m.username}${m.admin ? ' (admin)' : ''}`).join(', ');
        details.push(`members [${roster || 'none'}], expected "${check.hasMemberUsername}"`);
        if (check.memberIsAdmin !== undefined) {
          const isAdmin = member?.admin === true;
          if (isAdmin !== check.memberIsAdmin) passed = false;
          details.push(`admin flag is ${String(isAdmin)}, expected ${String(check.memberIsAdmin)}`);
        }
      }

      return { check, passed, detail: details.join('; ') };
    }

    case 'team-absent': {
      const team = await findTeam(client, check.nameContains);
      return {
        check,
        passed: !team,
        detail: team
          ? `team "${team.name}" (id ${team.id}) still exists, expected none matching ` +
            `"${check.nameContains}"`
          : `no team with name containing "${check.nameContains}"`,
      };
    }

    case 'project-has-share': {
      const project = await findProject(client, check.projectTitleContains);
      if (!project) {
        return { check, passed: false, detail: `no project with title containing "${check.projectTitleContains}"` };
      }
      const shares = await client.listShares(project.id);
      return {
        check,
        passed: shares.length >= 1,
        detail: `project "${project.title}" has ${shares.length} link share(s)`,
      };
    }

    case 'buckets-in-order': {
      const project = await findProject(client, check.projectTitleContains);
      if (!project) {
        return { check, passed: false, detail: `no project with title containing "${check.projectTitleContains}"` };
      }
      const buckets = await client.listBuckets(project.id);
      const actualNames = buckets.map((b) => b.title);
      // Ignore any bucket not named in `order` (e.g. a leftover default
      // bucket in an existing-project reuse case) -- only the RELATIVE order
      // of the named columns among themselves is asserted, case-insensitive
      // to match setup-kanban's own bucket-title matching.
      const matched = actualNames.filter((name) =>
        check.order.some((expected) => expected.toLowerCase() === name.toLowerCase()),
      );
      const passed =
        matched.length === check.order.length &&
        matched.every((name, i) => name.toLowerCase() === (check.order[i] as string).toLowerCase());
      return {
        check,
        passed,
        detail:
          `bucket order in "${project.title}": [${actualNames.join(', ') || 'none'}], ` +
          `expected relative order [${check.order.join(', ')}]`,
      };
    }
  }
}

export async function runVerification(scenario: Pick<Scenario, 'id'>, checks: VerifyCheck[], client: VikunjaRestClient): Promise<VerificationVerdict> {
  const results: CheckVerdict[] = [];
  for (const check of checks) {
    results.push(await runCheck(client, check));
  }
  return {
    scenarioId: scenario.id,
    passed: results.every((r) => r.passed),
    checks: results,
  };
}
