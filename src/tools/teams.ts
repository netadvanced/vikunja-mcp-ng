/**
 * Teams Tool
 * Handles team operations for Vikunja
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthManager } from '../auth/AuthManager';
import type { VikunjaClientFactory } from '../client/VikunjaClientFactory';
import { getAuthManagerFromContext, hasRequestContext } from '../client';
import { MCPError, ErrorCode, createStandardResponse } from '../types';
import { wrapToolError } from '../utils/error-handler';
import { vikunjaRestRequest } from '../utils/vikunja-rest';
import { validateAndConvertId } from '../utils/validation';
import { formatAorpAsMarkdown } from '../utils/response-factory';
import { assertWriteAllowed, getToolAnnotations, withReadOnlyNote } from '../utils/read-only';
import type { Team, TeamWithMembers } from './teams/types';
import { TeamUpdateContext } from './teams/update';
import {
  DEFAULT_SERVER_PAGE_CAP,
  describePossibleTruncation,
  readServerPageCap,
} from '../utils/filtering/pagination';

interface TeamListParams {
  page?: number;
  per_page?: number;
  s?: string;
}

// Use shared validateAndConvertId from utils/validation

/**
 * `models.TeamMember` — the team-membership row returned by
 * `PUT /teams/{id}/members` (add) and `POST /teams/{id}/members/{username}/admin`
 * (admin toggle).
 */
interface TeamMembership {
  id: number;
  username: string;
  admin?: boolean;
  created?: string;
}

/** `models.Message` — the generic `{ message: string }` envelope Vikunja
 * returns from `DELETE /teams/{id}/members/{username}`. */
interface VikunjaMessage {
  message: string;
}

export function registerTeamsTool(
  server: McpServer,
  authManager: AuthManager,
  _clientFactory?: VikunjaClientFactory,
): void {
  server.tool(
    'vikunja_teams',
    withReadOnlyNote(
      'vikunja_teams',
      'Manage teams and team memberships for collaborative project management',
    ),
    {
      // List all teams
      subcommand: z.enum(['list', 'create', 'get', 'update', 'delete', 'members']),

      // List parameters
      page: z.number().positive().optional(),
      perPage: z.number().positive().max(100).optional(),
      search: z.string().optional(),

      // Team fields for create/update
      id: z.union([z.string(), z.number()]).optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      // models.Team.is_public — "Defines whether the team should be publicly
      // discoverable when sharing a project". Present in the vendored 2.4.0
      // spec but previously unsettable here (reads passed it through, writes
      // never sent it).
      isPublic: z
        .boolean()
        .optional()
        .describe(
          'Whether the team is publicly discoverable when sharing a project. On update, ' +
            'omitting this leaves the stored value untouched, so pass isPublic only when ' +
            'you actually want to change it (see docs/VIKUNJA_API_ISSUES.md).',
        ),

      // Member operations
      // 'toggleAdmin' matches the real API: POST /teams/{id}/members/{username}/admin
      // takes no body and flips the member's admin flag rather than setting it.
      memberSubcommand: z.enum(['list', 'add', 'remove', 'toggleAdmin']).optional(),
      // Vikunja keys team membership by username, not numeric user id, to
      // prevent automated/enumerated user-id entry (see the API's own docs
      // for models.TeamMember.username).
      username: z.string().min(1).optional(),
      admin: z.boolean().optional(),
    },
    getToolAnnotations('vikunja_teams'),
    async (args) => {
      // Closure-gate precedence fix: defer to the per-request context when
      // bound (see hasRequestContext's doc comment, src/client.ts).
      if (hasRequestContext()) {
        await getAuthManagerFromContext();
      } else if (!authManager.isAuthenticated()) {
        throw new MCPError(
          ErrorCode.AUTH_REQUIRED,
          'Authentication required. Please use vikunja_auth.connect first.',
        );
      }

      const subcommand = args.subcommand;

      // 'members' fans out to a second enum (memberSubcommand) — that case
      // below calls assertWriteAllowed again with the composite
      // 'members:<memberSubcommand>' key once memberSubcommand is resolved.
      if (subcommand !== 'members') {
        assertWriteAllowed('vikunja_teams', subcommand);
      }

      try {
        switch (subcommand) {
          case 'list': {
            const params: TeamListParams = {};
            if (args.page !== undefined) params.page = args.page;
            if (args.perPage !== undefined) params.per_page = args.perPage;
            if (args.search !== undefined) params.s = args.search;

            const query = new URLSearchParams();
            if (params.page !== undefined) query.set('page', String(params.page));
            if (params.per_page !== undefined) query.set('per_page', String(params.per_page));
            if (params.s !== undefined) query.set('s', params.s);
            const queryString = query.toString();

            const teamsResult = await vikunjaRestRequest<Team[]>(
              authManager,
              'GET',
              `/teams${queryString ? `?${queryString}` : ''}`,
            );
            const teams = teamsResult ?? [];

            // "At minimum" half of the CRIT-7 pattern (issue #289 / HIGH-18
            // spot-check) — see `describePossibleTruncation`'s doc comment.
            const truncation = describePossibleTruncation(teams.length, {
              autoPaginate: args.page === undefined && args.perPage === undefined,
              cap: readServerPageCap(authManager) ?? DEFAULT_SERVER_PAGE_CAP,
              resourceLabel: 'GET /teams',
            });

            const response = createStandardResponse(
              'list-teams',
              `Retrieved ${teams.length} team${teams.length !== 1 ? 's' : ''}` +
                (truncation.resultComplete === false
                  ? ` — INCOMPLETE RESULT: ${truncation.warnings?.join(' ')}`
                  : ''),
              { teams },
              { count: teams.length, params, ...truncation },
            );

            return {
              content: [
                {
                  type: 'text',
                  text: formatAorpAsMarkdown(response),
                },
              ],
            };
          }

          case 'create': {
            if (!args.name) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Team name is required');
            }

            const teamData: Partial<Team> = {
              name: args.name,
            };
            if (args.description !== undefined) {
              teamData.description = args.description;
            }
            if (args.isPublic !== undefined) {
              teamData.is_public = args.isPublic;
            }

            const team = await vikunjaRestRequest<Team>(authManager, 'PUT', '/teams', teamData);

            const response = createStandardResponse(
              'create-team',
              `Team "${team.name}" created successfully`,
              { team },
              { affectedFields: Object.keys(teamData).filter((key) => typeof key === 'string') },
            );

            return {
              content: [
                {
                  type: 'text',
                  text: formatAorpAsMarkdown(response),
                },
              ],
            };
          }

          case 'get': {
            if (args.id === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Team ID is required');
            }

            const teamId = validateAndConvertId(args.id, 'id');

            const team = await vikunjaRestRequest<Team>(authManager, 'GET', `/teams/${teamId}`);

            const standardResponse = createStandardResponse(
              'get-team',
              `Retrieved team "${team.name}"`,
              { team },
              { teamId },
            );

            return {
              content: [
                {
                  type: 'text',
                  text: formatAorpAsMarkdown(standardResponse),
                },
              ],
            };
          }

          case 'update': {
            if (args.id === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Team ID is required');
            }

            const teamId = validateAndConvertId(args.id, 'id');

            if (!args.name && !args.description && args.isPublic === undefined) {
              throw new MCPError(
                ErrorCode.VALIDATION_ERROR,
                'At least one field to update is required',
              );
            }

            // Report the caller's explicit deltas, not every field the write
            // payload happens to carry.
            const affectedFields = [
              ...(args.name !== undefined ? ['name'] : []),
              ...(args.description !== undefined ? ['description'] : []),
              ...(args.isPublic !== undefined ? ['is_public'] : []),
            ];

            // Which API serves this, and the sequence it runs, is the strategy
            // pair's business (src/tools/teams/update/). v1 reads the team and
            // POSTs the whole merged model back, because that handler binds
            // into an empty struct and writes `is_public` with xorm's
            // `UseBool`; v2 sends one PATCH, which was probed live on 2.4.0,
            // 2.5.0 and 2.6.0 and has neither hazard. Both return the same
            // canonical team.
            const team = await new TeamUpdateContext(authManager).execute({
              authManager,
              teamId,
              args: {
                ...(args.name !== undefined && { name: args.name }),
                ...(args.description !== undefined && { description: args.description }),
                ...(args.isPublic !== undefined && { isPublic: args.isPublic }),
              },
            });

            const standardResponse = createStandardResponse(
              'update-team',
              `Team "${team.name}" updated successfully`,
              { team },
              { teamId, affectedFields },
            );

            return {
              content: [
                {
                  type: 'text',
                  text: formatAorpAsMarkdown(standardResponse),
                },
              ],
            };
          }

          case 'delete': {
            if (args.id === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Team ID is required');
            }

            const teamId = validateAndConvertId(args.id, 'id');

            const result = await vikunjaRestRequest<{ message?: string }>(
              authManager,
              'DELETE',
              `/teams/${teamId}`,
            );

            const response = createStandardResponse(
              'delete-team',
              `Team deleted successfully`,
              { message: result.message },
              { teamId },
            );

            return {
              content: [
                {
                  type: 'text',
                  text: formatAorpAsMarkdown(response),
                },
              ],
            };
          }

          case 'members': {
            if (args.id === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Team ID is required');
            }

            const teamId = validateAndConvertId(args.id, 'id');
            const memberSubcommand = args.memberSubcommand || 'list';

            assertWriteAllowed('vikunja_teams', `members:${memberSubcommand}`);

            switch (memberSubcommand) {
              case 'list': {
                // There is no GET /teams/{id}/members endpoint. Members are
                // embedded in the team resource itself, so fetch the team
                // and read its `members` array.
                const team = await vikunjaRestRequest<TeamWithMembers>(
                  authManager,
                  'GET',
                  `/teams/${teamId}`,
                );
                const members = team.members ?? [];

                const standardResponse = createStandardResponse(
                  'list-team-members',
                  `Retrieved ${members.length} member${members.length !== 1 ? 's' : ''}`,
                  { members },
                  { teamId, count: members.length },
                );

                return {
                  content: [
                    {
                      type: 'text',
                      text: formatAorpAsMarkdown(standardResponse),
                    },
                  ],
                };
              }

              case 'add': {
                if (!args.username) {
                  throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Username is required');
                }

                // The API keys team membership by the member's real username
                // string (deliberately, to prevent automated/enumerated user
                // id entry) — never a numeric user id.
                const memberData: { username: string; admin?: boolean } = {
                  username: args.username,
                };
                if (args.admin !== undefined) memberData.admin = args.admin;

                const member = await vikunjaRestRequest<TeamMembership>(
                  authManager,
                  'PUT',
                  `/teams/${teamId}/members`,
                  memberData,
                );

                const standardResponse = createStandardResponse(
                  'add-team-member',
                  `User "${args.username}" added to team successfully`,
                  { member },
                  { teamId, username: args.username, admin: args.admin },
                );

                return {
                  content: [
                    {
                      type: 'text',
                      text: formatAorpAsMarkdown(standardResponse),
                    },
                  ],
                };
              }

              case 'remove': {
                if (!args.username) {
                  throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Username is required');
                }

                // The path segment is the member's username, not a numeric
                // user id — /teams/{id}/members/{username}.
                const result = await vikunjaRestRequest<VikunjaMessage>(
                  authManager,
                  'DELETE',
                  `/teams/${teamId}/members/${args.username}`,
                );

                const standardResponse = createStandardResponse(
                  'remove-team-member',
                  `User "${args.username}" removed from team successfully`,
                  { message: result.message },
                  { teamId, username: args.username },
                );

                return {
                  content: [
                    {
                      type: 'text',
                      text: formatAorpAsMarkdown(standardResponse),
                    },
                  ],
                };
              }

              case 'toggleAdmin': {
                if (!args.username) {
                  throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Username is required');
                }

                // POST /teams/{id}/members/{username}/admin takes no request
                // body: it TOGGLES the member's admin flag rather than
                // setting it to a caller-supplied value, so there is no
                // `admin` argument here — callers should read the member's
                // current status first (e.g. via `members list`) if they
                // need to know the resulting state.
                const member = await vikunjaRestRequest<TeamMembership>(
                  authManager,
                  'POST',
                  `/teams/${teamId}/members/${args.username}/admin`,
                );

                const standardResponse = createStandardResponse(
                  'toggle-team-member-admin',
                  `Admin status toggled for user "${args.username}"`,
                  { member },
                  { teamId, username: args.username },
                );

                return {
                  content: [
                    {
                      type: 'text',
                      text: formatAorpAsMarkdown(standardResponse),
                    },
                  ],
                };
              }

              default:
                throw new MCPError(
                  ErrorCode.VALIDATION_ERROR,
                  `Invalid member subcommand: ${String(memberSubcommand)}`,
                );
            }
          }

          default:
            throw new MCPError(
              ErrorCode.VALIDATION_ERROR,
              `Invalid subcommand: ${String(subcommand)}`,
            );
        }
      } catch (error) {
        throw wrapToolError(error, 'vikunja_teams', `${subcommand} team`, args.id);
      }
    },
  );
}
