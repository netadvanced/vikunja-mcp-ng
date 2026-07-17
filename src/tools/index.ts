/**
 * Tool Registration
 * Registers all Vikunja tools with the MCP server using conditional registration
 *
 * Registration Strategy:
 * - Core tools (auth, tasks): Always registered
 * - Client-dependent tools: Only registered when clientFactory is available
 * - JWT-restricted tools (users, export): Only registered with JWT authentication
 *
 * This approach ensures tool availability matches authentication capabilities
 * and prevents API errors from unsupported token types.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthManager } from '../auth/AuthManager';
import type { VikunjaClientFactory } from '../client/VikunjaClientFactory';
import type { ModulesConfig } from '../config';
import { ConfigurationManager, ModulesConfigSchema, isModuleEnabled } from '../config';
import { logger } from '../utils/logger';

import { registerAuthTool } from './auth';
import { registerTasksTool } from './tasks';
import { registerTaskCrudTool } from './task-crud';
import { registerTaskBulkTool } from './task-bulk';
import { registerTaskAssigneesTool } from './task-assignees';
import { registerTaskCommentsTool } from './task-comments';
import { registerTaskRemindersTool } from './task-reminders';
import { registerTaskLabelsTool } from './task-labels';
import { registerTaskRelationsTool } from './task-relations';
import { registerProjectsTool } from './projects/index';
import { registerLabelsTool } from './labels';
import { registerTeamsTool } from './teams';
import { registerUsersTool } from './users';
import { registerFiltersTool } from './filters';
import { registerTemplatesTool } from './templates';
import { registerWebhooksTool } from './webhooks';
import { registerBatchImportTool } from './batch-import';
import { registerExportTool } from './export';

// Re-export for testing
export {
  registerAuthTool,
  registerTasksTool,
  registerTaskCrudTool,
  registerTaskBulkTool,
  registerTaskAssigneesTool,
  registerTaskCommentsTool,
  registerTaskRemindersTool,
  registerTaskLabelsTool,
  registerTaskRelationsTool,
  registerProjectsTool,
  registerLabelsTool,
  registerTeamsTool,
  registerUsersTool,
  registerFiltersTool,
  registerTemplatesTool,
  registerWebhooksTool,
  registerBatchImportTool,
  registerExportTool,
};

/**
 * Resolve the module gating configuration, failing safe rather than fatal.
 *
 * `ConfigurationManager.loadConfiguration()` fails fast (throws) on a
 * malformed config file or a `_FILE`/plain env var conflict — appropriate for
 * a direct, single-shot config load. Tool registration, however, can be
 * retried (see the fallback registration paths in `src/index.ts`), and a
 * config error must not spiral into a repeated-throw/unhandled-rejection
 * crash loop there. So here we load once, log clearly on failure, and fall
 * back to the schema's built-in module defaults so the server still starts
 * with sane (default-on / dangerous-off) gating rather than not starting at all.
 */
function resolveModulesConfig(): ModulesConfig {
  try {
    return ConfigurationManager.getInstance().loadConfiguration().modules;
  } catch (error) {
    logger.error(
      'Failed to load module gating configuration; falling back to defaults ' +
        '(ordinary modules ON, dangerous modules OFF):',
      error
    );
    return ModulesConfigSchema.parse({});
  }
}

/**
 * Module-gated tool registration.
 *
 * Every module toggle (see `src/config/types.ts` ModulesConfigSchema) is
 * resolved once up front and applied here, at registration time: a disabled
 * module's tools are simply never registered, so they are invisible to the
 * MCP client rather than merely rejecting calls. Module config can only
 * NARROW what authentication already allows — the JWT-only gating below for
 * `users`/`export` is applied in addition to (never instead of) the module
 * check, so no config setting can grant access auth doesn't already permit.
 */
export function registerTools(
  server: McpServer,
  authManager: AuthManager,
  clientFactory?: VikunjaClientFactory
): void {
  // Register tools with conditional availability based on dependencies, module
  // gating configuration, and authentication.
  const modules = resolveModulesConfig();

  registerAuthTool(server, authManager);

  // Register the comprehensive tasks tool and its granular counterparts,
  // gated together behind the single "tasks" module toggle.
  if (isModuleEnabled(modules.tasks)) {
    registerTasksTool(server, authManager, clientFactory);
    registerTaskCrudTool(server, authManager, clientFactory);
    registerTaskBulkTool(server, authManager, clientFactory);
    registerTaskAssigneesTool(server, authManager, clientFactory);
    registerTaskCommentsTool(server, authManager, clientFactory);
    registerTaskRemindersTool(server, authManager, clientFactory);
    registerTaskLabelsTool(server, authManager, clientFactory);
    registerTaskRelationsTool(server, authManager, clientFactory);
  }

  // Only register tools that require clientFactory if it's available
  if (clientFactory) {
    if (isModuleEnabled(modules.projects)) {
      registerProjectsTool(server, authManager, clientFactory);
    }

    if (isModuleEnabled(modules.labels)) {
      registerLabelsTool(server, authManager, clientFactory);
    }

    if (isModuleEnabled(modules.teams)) {
      registerTeamsTool(server, authManager, clientFactory);
    }

    // Register filters tool (needs auth manager for session-scoped storage)
    if (isModuleEnabled(modules.filters)) {
      registerFiltersTool(server, authManager, clientFactory);
    }

    // Register templates tool
    if (isModuleEnabled(modules.templates)) {
      registerTemplatesTool(server, authManager, clientFactory);
    }

    // Register webhooks tool
    if (isModuleEnabled(modules.webhooks)) {
      registerWebhooksTool(server, authManager, clientFactory);
    }

    // Register batch import tool
    if (isModuleEnabled(modules.batchImport)) {
      registerBatchImportTool(server, authManager, clientFactory);
    }

    // Register user and export tools conditionally (preserving backward compatibility)
    // NOTE: The permission infrastructure is available for future migration.
    // Module config can only narrow this JWT-only gate, never expand it.
    const jwtAuthenticated = authManager.isAuthenticated() && authManager.getAuthType() === 'jwt';
    if (jwtAuthenticated && isModuleEnabled(modules.users)) {
      registerUsersTool(server, authManager, clientFactory);
    }
    if (jwtAuthenticated && isModuleEnabled(modules.export)) {
      registerExportTool(server, authManager, clientFactory);
    }
  }
}

