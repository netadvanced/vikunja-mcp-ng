/**
 * Users Tool Tests
 *
 * Migrated off node-vikunja (Wave D domain migration, tracking issue #28)
 * onto `vikunjaRestRequest`. Mocks the REST layer directly (module-level
 * mock of `vikunjaRestRequest`, the same approach the pre-existing
 * 'timezones' subcommand test already used) rather than a node-vikunja
 * client — see docs/ENDPOINT-PLAYBOOK.md §6.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AuthManager } from '../../src/auth/AuthManager';
import { registerUsersTool } from '../../src/tools/users';
import { MCPError, ErrorCode } from '../../src/types';
import type { MockAuthManager, MockServer } from '../types/mocks';
import { parseMarkdown } from '../utils/markdown';

// Import the function we're mocking
import { vikunjaRestRequest, vikunjaRestMultipartRequest } from '../../src/utils/vikunja-rest';
import { ConfigurationManager } from '../../src/config';
import { callAndCatch, isReadOnlyRejection } from '../utils/read-only-test-helpers';

jest.mock('../../src/auth/AuthManager');
jest.mock('../../src/utils/vikunja-rest', () => ({
  vikunjaRestRequest: jest.fn(),
  vikunjaRestMultipartRequest: jest.fn(),
}));

describe('Users Tool', () => {
  let mockAuthManager: MockAuthManager;
  let mockServer: MockServer;
  let toolHandler: (args: any) => Promise<any>;

  // Helper function to call a tool
  async function callTool(subcommand?: string, args: Record<string, any> = {}) {
    return toolHandler({
      subcommand,
      ...args,
    });
  }

  // Mock data
  // Mirrors the real Vikunja GET /user response shape (v1.UserWithSettings):
  // id, username, email, created, updated live at the top level, while
  // language, timezone, week_start, frontend_settings, email_reminders_enabled,
  // overdue_tasks_reminders_enabled, overdue_tasks_reminders_time and name are
  // nested under `settings` (models.UserGeneralSettings). Earlier versions of
  // this mock incorrectly put all of these flat at the top level, which is how
  // the transformUser() bug (reading them flat instead of from `settings`)
  // went undetected.
  const mockUser = {
    id: 1,
    username: 'testuser',
    email: 'test@example.com',
    created: '2025-01-01T00:00:00Z',
    updated: '2025-01-01T00:00:00Z',
    is_admin: false,
    is_local_user: true,
    auth_provider: '',
    settings: {
      name: 'Test User',
      language: 'en',
      timezone: 'UTC',
      week_start: 1,
      frontend_settings: {},
      email_reminders_enabled: true,
      overdue_tasks_reminders_enabled: false,
      overdue_tasks_reminders_time: '09:00',
    },
  };

  beforeEach(() => {
    (vikunjaRestRequest as jest.Mock).mockReset();
    (vikunjaRestMultipartRequest as jest.Mock).mockReset();

    // Setup mock auth manager
    mockAuthManager = {
      isAuthenticated: jest.fn().mockReturnValue(true),
      getAuthType: jest.fn().mockReturnValue('jwt'),
      getAuthenticatedClient: jest.fn(),
      updateCredentials: jest.fn(),
      clearCredentials: jest.fn(),
      verifyCredentials: jest.fn(),
      getCredentials: jest.fn(),
      authenticate: jest.fn(),
      getSession: jest.fn(),
      setSession: jest.fn(),
      clearSession: jest.fn(),
    } as MockAuthManager;

    // Setup mock server
    mockServer = {
      tool: jest.fn() as jest.MockedFunction<
        (name: string, description: string, schema: any, handler: any) => void
      >,
    } as MockServer;

    // Register the tool
    registerUsersTool(mockServer, mockAuthManager as unknown as AuthManager);

    // Get the tool handler
    expect(mockServer.tool).toHaveBeenCalledWith(
      'vikunja_users',
      expect.any(String),
      expect.any(Object),
      expect.any(Object), // ToolAnnotations
      expect.any(Function),
    );
    const calls = mockServer.tool.mock.calls;
    if (calls.length > 0 && calls[0] && calls[0].length > 3) {
      toolHandler = calls[0][calls[0].length - 1];
    } else {
      throw new Error('Tool handler not found');
    }
  });

  describe('Authentication', () => {
    it('should require authentication for all operations', async () => {
      mockAuthManager.isAuthenticated.mockReturnValue(false);

      await expect(callTool('current')).rejects.toThrow(
        'Authentication required. Please use vikunja_auth.connect first.',
      );
    });

    it('should require JWT authentication for all operations', async () => {
      mockAuthManager.isAuthenticated.mockReturnValue(true);
      mockAuthManager.getAuthType.mockReturnValue('api-token');

      await expect(callTool('current')).rejects.toThrow(
        'User operations require JWT authentication. Please reconnect using vikunja_auth.connect with JWT authentication.',
      );
    });

    it('should allow operations with JWT authentication', async () => {
      mockAuthManager.isAuthenticated.mockReturnValue(true);
      mockAuthManager.getAuthType.mockReturnValue('jwt');
      (vikunjaRestRequest as jest.Mock).mockResolvedValue(mockUser);

      const result = await callTool('current');

      expect(result.content[0].type).toBe('text');
      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain('## ✅ Success');
      expect(markdown).toContain('**Operation:** get-current-user');
    });
  });

  describe('current subcommand', () => {
    it('should get current user info', async () => {
      (vikunjaRestRequest as jest.Mock).mockResolvedValue(mockUser);

      const result = await callTool('current');

      expect(vikunjaRestRequest).toHaveBeenCalledWith(mockAuthManager, 'GET', '/user');
      expect(result.content[0].type).toBe('text');
      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain('## ✅ Success');
      expect(markdown).toContain('**Operation:** get-current-user');
      expect(markdown).toContain('Current user retrieved successfully');
    });

    it('should handle API errors', async () => {
      (vikunjaRestRequest as jest.Mock).mockRejectedValue(new Error('API Error'));

      await expect(callTool('current')).rejects.toThrow('User operation error: API Error');
    });

    it('should handle non-Error API errors', async () => {
      (vikunjaRestRequest as jest.Mock).mockRejectedValue('String error');

      await expect(callTool('current')).rejects.toThrow('User operation error: String error');
    });

    it('should surface settings nested under `settings` on the raw API response (B2-users-settings)', async () => {
      // Regression test: GET /user returns v1.UserWithSettings, where
      // language/timezone/week_start/frontend_settings/email_reminders_enabled/
      // overdue_tasks_reminders_enabled/overdue_tasks_reminders_time/name live
      // under `settings`, not flat on the response. Before the fix,
      // transformUser() read these flat and they were silently dropped.
      (vikunjaRestRequest as jest.Mock).mockResolvedValue(mockUser);

      const result = await callTool('current');

      const markdown = result.content[0].text;
      expect(markdown).toContain('"name": "Test User"');
      expect(markdown).toContain('"language": "en"');
      expect(markdown).toContain('"timezone": "UTC"');
      expect(markdown).toContain('"week_start": 1');
      expect(markdown).toContain('"email_reminders_enabled": true');
      expect(markdown).toContain('"overdue_tasks_reminders_enabled": false');
      expect(markdown).toContain('"overdue_tasks_reminders_time": "09:00"');
    });

    // The spec declares `name` on BOTH v1.UserWithSettings (top level) and
    // its nested models.UserGeneralSettings — a real GET /user carries it in
    // both places, so neither reading alone may be the only one that works.
    it('reads the top-level name of a v1.UserWithSettings response (#281)', async () => {
      (vikunjaRestRequest as jest.Mock).mockResolvedValue({
        ...mockUser,
        name: 'Top Level Name',
        settings: { ...mockUser.settings, name: undefined },
      });

      const result = await callTool('current');

      expect(result.content[0].text).toContain('"name": "Top Level Name"');
    });
  });

  describe('search subcommand', () => {
    it('should search for users', async () => {
      const mockUsers = [mockUser, { ...mockUser, id: 2, username: 'user2' }];
      (vikunjaRestRequest as jest.Mock).mockResolvedValue(mockUsers);

      const result = await callTool('search');

      expect(vikunjaRestRequest).toHaveBeenCalledWith(mockAuthManager, 'GET', '/users');
      expect(result.content[0].type).toBe('text');
      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain('## ✅ Success');
      expect(markdown).toContain('**Operation:** search-users');
      expect(markdown).toContain('Found 2 users');
    });

    it('should support search parameter', async () => {
      (vikunjaRestRequest as jest.Mock).mockResolvedValue([mockUser]);

      const result = await callTool('search', { search: 'test' });

      expect(vikunjaRestRequest).toHaveBeenCalledWith(mockAuthManager, 'GET', '/users?s=test');
      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain('## ✅ Success');
      expect(markdown).toContain('**Operation:** search-users');
    });

    // Issue #281: GET /users returns plain `user.User` objects — `name` is
    // top-level and there is no `settings` key at all (see
    // src/types/generated/vikunja-openapi.d.ts, "user.User"). Reading the
    // name only out of `settings` dropped it from every search result.
    it('keeps the top-level name of a plain user.User search result (#281)', async () => {
      (vikunjaRestRequest as jest.Mock).mockResolvedValue([
        {
          id: 7,
          username: 'searchtarget',
          email: 'target@example.com',
          name: 'Search Target',
          created: '2025-01-01T00:00:00Z',
          updated: '2025-01-01T00:00:00Z',
        },
      ]);

      const result = await callTool('search', { search: 'target' });

      // The list renderer prefers the display name; before the fix the name
      // was dropped by transformUser and the username was shown instead.
      expect(result.content[0].text).toContain('**Search Target**');
      expect(result.content[0].text).not.toContain('**searchtarget**');
    });

    it('should accept pagination parameters without sending them (GET /users has no page/per_page)', async () => {
      // GET /users only accepts `s` per the OpenAPI spec — node-vikunja's
      // SearchParams type modeled page/per_page but the real endpoint has no
      // such query params. page/perPage are still accepted as tool arguments
      // (surfaced in response metadata) but are not sent over the wire.
      //
      // ALREADY FIXED (docs/API-COVERAGE.md Issues table, LOW): this test
      // pre-dates the E4 residual-coverage-issues pass and already proves
      // the fix — the outgoing URL below is exactly '/users' with no query
      // string, confirming page/perPage never reach the wire.
      (vikunjaRestRequest as jest.Mock).mockResolvedValue([mockUser]);

      const result = await callTool('search', { page: 2, perPage: 10 });

      expect(vikunjaRestRequest).toHaveBeenCalledWith(mockAuthManager, 'GET', '/users');
      const markdown = result.content[0].text;
      expect(markdown).toContain('2'); // page number surfaced in metadata
    });

    it('should handle API errors', async () => {
      (vikunjaRestRequest as jest.Mock).mockRejectedValue(new Error('Search failed'));

      await expect(callTool('search')).rejects.toThrow('User operation error: Search failed');
    });
  });

  describe('settings subcommand', () => {
    it('should get user settings', async () => {
      (vikunjaRestRequest as jest.Mock).mockResolvedValue(mockUser);

      const result = await callTool('settings');

      expect(vikunjaRestRequest).toHaveBeenCalledWith(mockAuthManager, 'GET', '/user');
      expect(result.content[0].type).toBe('text');
      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain('## ✅ Success');
      expect(markdown).toContain('**Operation:** get-user-settings');
      expect(markdown).toContain('User settings retrieved successfully');
    });

    it('should surface nested settings fields in the settings summary (B2-users-settings)', async () => {
      (vikunjaRestRequest as jest.Mock).mockResolvedValue(mockUser);

      const result = await callTool('settings');

      const markdown = result.content[0].text;
      expect(markdown).toContain('"name": "Test User"');
      expect(markdown).toContain('"language": "en"');
      expect(markdown).toContain('"timezone": "UTC"');
      expect(markdown).toContain('"weekStart": 1');
      expect(markdown).toContain('"emailRemindersEnabled": true');
      expect(markdown).toContain('"overdueTasksRemindersEnabled": false');
      expect(markdown).toContain('"overdueTasksRemindersTime": "09:00"');
    });

    it('should handle API errors', async () => {
      (vikunjaRestRequest as jest.Mock).mockRejectedValue(new Error('Failed to get settings'));

      await expect(callTool('settings')).rejects.toThrow(
        'User operation error: Failed to get settings',
      );
    });
  });

  describe('update-settings subcommand', () => {
    // POST /user/settings/general is a FULL-MODEL REPLACE: the server binds a
    // fresh v1.UserSettings from the body and assigns every one of its fields
    // onto the user, so any key the body omits is written back as its Go zero
    // value. This tool therefore GETs /user first and merges the caller's
    // deltas onto the current settings (docs/ENDPOINT-PLAYBOOK.md §4), which
    // makes the call order: GET /user -> POST /user/settings/general ->
    // GET /user (read-back).
    const currentSettings = mockUser.settings;

    /** Arrange the GET-merge-POST-GET sequence and return the POSTed body. */
    function mockRoundTrip(readBack: unknown = mockUser): void {
      (vikunjaRestRequest as jest.Mock)
        .mockResolvedValueOnce(mockUser) // GET /user (merge base)
        .mockResolvedValueOnce({ message: 'Success' }) // POST /user/settings/general
        .mockResolvedValueOnce(readBack); // GET /user (read-back)
    }

    /** The body of the POST /user/settings/general call. */
    function postedSettings(): Record<string, unknown> {
      const calls = (vikunjaRestRequest as jest.Mock).mock.calls as unknown[][];
      const post = calls.find((c) => c[1] === 'POST' && c[2] === '/user/settings/general') as
        unknown[] | undefined;
      if (!post) throw new Error('POST /user/settings/general was never called');
      return post[3] as Record<string, unknown>;
    }

    it('merges deltas onto the CURRENT settings instead of sending a partial body', async () => {
      mockRoundTrip({
        ...mockUser,
        settings: { ...currentSettings, name: 'Updated Name', language: 'es' },
      });

      const result = await callTool('update-settings', {
        name: 'Updated Name',
        language: 'es',
      });

      expect(vikunjaRestRequest).toHaveBeenNthCalledWith(1, mockAuthManager, 'GET', '/user');
      // The wire payload carries EVERY setting, not just the two changed ones -
      // otherwise the server would zero timezone, week_start, the reminder
      // preferences and both discoverability flags.
      expect(postedSettings()).toEqual({
        ...currentSettings,
        name: 'Updated Name',
        language: 'es',
      });
      expect(vikunjaRestRequest).toHaveBeenNthCalledWith(3, mockAuthManager, 'GET', '/user');
      const markdown = result.content[0].text;
      expect(markdown).toContain('## ✅ Success');
      expect(markdown).toContain('**Operation:** update-user-settings');
      expect(markdown).toContain('User settings updated successfully');
    });

    it('preserves a field the caller never mentioned (data-loss regression guard)', async () => {
      mockRoundTrip();

      await callTool('update-settings', { name: 'Only The Name' });

      const body = postedSettings();
      // Untouched fields survive the round trip at their current values.
      expect(body.timezone).toBe('UTC');
      expect(body.week_start).toBe(1);
      expect(body.email_reminders_enabled).toBe(true);
      expect(body.overdue_tasks_reminders_time).toBe('09:00');
      expect(body.name).toBe('Only The Name');
    });

    it('drops the read-only extra_settings_links from the merged body', async () => {
      (vikunjaRestRequest as jest.Mock)
        .mockResolvedValueOnce({
          ...mockUser,
          settings: { ...currentSettings, extra_settings_links: { docs: 'https://example.com' } },
        })
        .mockResolvedValueOnce({ message: 'Success' })
        .mockResolvedValueOnce(mockUser);

      await callTool('update-settings', { name: 'X' });

      expect(postedSettings()).not.toHaveProperty('extra_settings_links');
    });

    it('falls back to an empty base when GET /user returns no settings object', async () => {
      (vikunjaRestRequest as jest.Mock)
        .mockResolvedValueOnce({ id: 1, username: 'testuser' })
        .mockResolvedValueOnce({ message: 'Success' })
        .mockResolvedValueOnce(mockUser);

      await callTool('update-settings', { language: 'de' });

      expect(postedSettings()).toEqual({ language: 'de' });
    });

    // ---------------------------------------------------------------------
    // Previously-undeclared write fields on models.UserGeneralSettings.
    // They were not in the tool shape at all, so Zod stripped them and the
    // agent's request vanished with a "settings updated successfully".
    // ---------------------------------------------------------------------
    it('forwards defaultProjectId, discoverableByEmail and discoverableByName', async () => {
      mockRoundTrip();

      const result = await callTool('update-settings', {
        defaultProjectId: 42,
        discoverableByEmail: true,
        discoverableByName: true,
      });

      const body = postedSettings();
      expect(body.default_project_id).toBe(42);
      expect(body.discoverable_by_email).toBe(true);
      expect(body.discoverable_by_name).toBe(true);
      const markdown = result.content[0].text;
      expect(markdown).toContain('defaultProjectId');
      expect(markdown).toContain('discoverableByEmail');
      expect(markdown).toContain('discoverableByName');
    });

    // The falsy cases. `discoverable_by_*` are xorm UseBool-style columns:
    // a guard written as `if (value)` would drop exactly the "turn this OFF"
    // request, which is the privacy-relevant direction.
    it('forwards discoverableByEmail/Name === false (the falsy case)', async () => {
      mockRoundTrip();

      const result = await callTool('update-settings', {
        discoverableByEmail: false,
        discoverableByName: false,
      });

      const body = postedSettings();
      expect(body.discoverable_by_email).toBe(false);
      expect(body.discoverable_by_name).toBe(false);
      expect(result.content[0].text).toContain('discoverableByEmail');
    });

    it('forwards defaultProjectId === 0 (clears the default project)', async () => {
      mockRoundTrip();

      await callTool('update-settings', { defaultProjectId: 0 });

      expect(postedSettings().default_project_id).toBe(0);
    });

    it('treats an empty name as a supplied field, not a missing one', async () => {
      mockRoundTrip();

      await callTool('update-settings', { name: '' });

      expect(postedSettings().name).toBe('');
    });

    it('surfaces the discoverability + default project settings on read-back', async () => {
      mockRoundTrip({
        ...mockUser,
        settings: {
          ...currentSettings,
          discoverable_by_email: false,
          discoverable_by_name: true,
          default_project_id: 7,
        },
      });

      const result = await callTool('update-settings', { discoverableByName: true });
      const markdown = result.content[0].text;
      expect(markdown).toContain('discoverable_by_name');
      expect(markdown).toContain('default_project_id');
    });

    it('should update all settings fields', async () => {
      mockRoundTrip();

      const result = await callTool('update-settings', {
        name: 'New Name',
        language: 'fr',
        timezone: 'Europe/Paris',
        weekStart: 0,
        frontendSettings: { theme: 'dark' },
      });

      expect(postedSettings()).toEqual({
        ...currentSettings,
        name: 'New Name',
        language: 'fr',
        timezone: 'Europe/Paris',
        week_start: 0,
        frontend_settings: { theme: 'dark' },
      });
      const markdown = result.content[0].text;
      expect(markdown).toContain('name');
      expect(markdown).toContain('language');
      expect(markdown).toContain('timezone');
    });

    it('should update notification preferences', async () => {
      mockRoundTrip({
        ...mockUser,
        settings: {
          ...currentSettings,
          email_reminders_enabled: false,
          overdue_tasks_reminders_enabled: true,
          overdue_tasks_reminders_time: '08:00',
        },
      });

      const result = await callTool('update-settings', {
        emailRemindersEnabled: false,
        overdueTasksRemindersEnabled: true,
        overdueTasksRemindersTime: '08:00',
      });

      expect(postedSettings()).toEqual({
        ...currentSettings,
        email_reminders_enabled: false,
        overdue_tasks_reminders_enabled: true,
        overdue_tasks_reminders_time: '08:00',
      });
      const markdown = result.content[0].text;
      expect(markdown).toContain('emailRemindersEnabled');
      expect(markdown).toContain('overdueTasksRemindersEnabled');
    });

    it('should update mixed settings including notifications', async () => {
      mockRoundTrip();

      const result = await callTool('update-settings', {
        name: 'Updated Name',
        emailRemindersEnabled: true,
        overdueTasksRemindersTime: '10:00',
      });

      expect(postedSettings()).toEqual({
        ...currentSettings,
        name: 'Updated Name',
        email_reminders_enabled: true,
        overdue_tasks_reminders_time: '10:00',
      });
      const markdown = result.content[0].text;
      expect(markdown).toContain('name');
      expect(markdown).toContain('emailRemindersEnabled');
    });

    it('should require at least one field to update', async () => {
      await expect(callTool('update-settings')).rejects.toThrow(
        'At least one setting field is required',
      );
      // Nothing is read or written when there is nothing to change.
      expect(vikunjaRestRequest).not.toHaveBeenCalled();
    });

    it('should handle weekStart as 0', async () => {
      mockRoundTrip();

      const result = await callTool('update-settings', { weekStart: 0 });

      expect(postedSettings()).toEqual({ ...currentSettings, week_start: 0 });
      const markdown = result.content[0].text;
      expect(markdown).toContain('weekStart');
    });

    it('should handle API errors', async () => {
      (vikunjaRestRequest as jest.Mock).mockRejectedValue(new Error('Update failed'));

      await expect(callTool('update-settings', { name: 'New Name' })).rejects.toThrow(
        'User operation error: Update failed',
      );
    });
  });

  describe('timezones subcommand', () => {
    it('should fetch GET /user/timezones via the direct-REST helper', async () => {
      (vikunjaRestRequest as jest.Mock).mockResolvedValue([
        'UTC',
        'Europe/Zurich',
        'America/New_York',
      ]);

      const result = await callTool('timezones');

      expect(vikunjaRestRequest).toHaveBeenCalledWith(mockAuthManager, 'GET', '/user/timezones');
      expect(result.content[0].type).toBe('text');
      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      const aorpStatus = parsed.getAorpStatus();
      expect(aorpStatus.type).toBe('success');
      expect(markdown).toContain('get-user-timezones');
      expect(markdown).toContain('Europe/Zurich');
      expect(markdown).toContain('**count:** 3');
    });

    it('should handle an empty/null response gracefully', async () => {
      (vikunjaRestRequest as jest.Mock).mockResolvedValue(null);

      const result = await callTool('timezones');

      const markdown = result.content[0].text;
      expect(markdown).toContain('**count:** 0');
    });

    it('should still require JWT authentication', async () => {
      mockAuthManager.isAuthenticated.mockReturnValue(true);
      mockAuthManager.getAuthType.mockReturnValue('api-token');

      await expect(callTool('timezones')).rejects.toThrow(
        'User operations require JWT authentication. Please reconnect using vikunja_auth.connect with JWT authentication.',
      );
      expect(vikunjaRestRequest).not.toHaveBeenCalled();
    });
  });

  describe('get-avatar subcommand', () => {
    it('should fetch GET /user/settings/avatar and surface avatar_provider', async () => {
      (vikunjaRestRequest as jest.Mock).mockResolvedValue({ avatar_provider: 'gravatar' });

      const result = await callTool('get-avatar');

      expect(vikunjaRestRequest).toHaveBeenCalledWith(
        mockAuthManager,
        'GET',
        '/user/settings/avatar',
      );
      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(parsed.getAorpStatus().type).toBe('success');
      expect(markdown).toContain('get-avatar-provider');
      expect(markdown).toContain('**avatarProvider:** gravatar');
    });

    it('should default to an empty string when avatar_provider is missing', async () => {
      (vikunjaRestRequest as jest.Mock).mockResolvedValue({});

      const result = await callTool('get-avatar');

      const markdown = result.content[0].text;
      // formatObjectData filters out '' the same as undefined/null? No —
      // only undefined/null are filtered, so an empty-string avatarProvider
      // still renders as an explicit (empty) value.
      expect(markdown).toContain('**avatarProvider:**');
    });

    it('should handle API errors', async () => {
      (vikunjaRestRequest as jest.Mock).mockRejectedValue(new Error('Avatar fetch failed'));

      await expect(callTool('get-avatar')).rejects.toThrow(
        'User operation error: Avatar fetch failed',
      );
    });
  });

  describe('set-avatar subcommand', () => {
    it('should POST /user/settings/avatar with the chosen provider', async () => {
      (vikunjaRestRequest as jest.Mock).mockResolvedValue({ message: 'Success' });

      const result = await callTool('set-avatar', { avatarProvider: 'marble' });

      expect(vikunjaRestRequest).toHaveBeenCalledWith(
        mockAuthManager,
        'POST',
        '/user/settings/avatar',
        { avatar_provider: 'marble' },
      );
      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(parsed.getAorpStatus().type).toBe('success');
      expect(markdown).toContain("Avatar provider set to 'marble'");
    });

    it("should note that 'upload-avatar' is needed to complete the switch to upload", async () => {
      (vikunjaRestRequest as jest.Mock).mockResolvedValue({ message: 'Success' });

      const result = await callTool('set-avatar', { avatarProvider: 'upload' });

      const markdown = result.content[0].text;
      expect(markdown).toContain("call 'upload-avatar'");
    });

    it('should reject each of the seven valid providers, and no others, via schema semantics', () => {
      // Documents the exact accepted set (sourced from the Vikunja server's
      // own validation, not just the freeform-string OpenAPI field) that the
      // Zod schema enforces before this handler ever runs.
      const validProviders = [
        'gravatar',
        'upload',
        'initials',
        'marble',
        'ldap',
        'openid',
        'default',
      ];
      expect(validProviders).toHaveLength(7);
    });

    it('should require avatarProvider', async () => {
      await expect(callTool('set-avatar')).rejects.toThrow('set-avatar requires avatarProvider');
      expect(vikunjaRestRequest).not.toHaveBeenCalled();
    });

    it('should handle API errors', async () => {
      (vikunjaRestRequest as jest.Mock).mockRejectedValue(new Error('Set avatar failed'));

      await expect(callTool('set-avatar', { avatarProvider: 'gravatar' })).rejects.toThrow(
        'User operation error: Set avatar failed',
      );
    });
  });

  describe('upload-avatar subcommand', () => {
    it('should reject missing filePath and fileContent', async () => {
      await expect(callTool('upload-avatar')).rejects.toThrow(
        'upload-avatar requires filePath or fileContent',
      );
      expect(vikunjaRestMultipartRequest).not.toHaveBeenCalled();
    });

    it('should reject fileContent that decodes to empty bytes', async () => {
      await expect(callTool('upload-avatar', { fileContent: '====' })).rejects.toThrow(
        'upload-avatar: decoded fileContent is empty',
      );
    });

    it('should read filePath and upload with basename when filename omitted', async () => {
      const tmp = join(tmpdir(), `avatar-test-${Date.now()}-${process.pid}.png`);
      writeFileSync(tmp, 'fake-png-bytes');
      try {
        (vikunjaRestMultipartRequest as jest.Mock).mockResolvedValue({ message: 'Success' });
        const result = await callTool('upload-avatar', { filePath: tmp });

        expect(vikunjaRestMultipartRequest).toHaveBeenCalledWith(
          mockAuthManager,
          'PUT',
          '/user/settings/avatar/upload',
          expect.any(FormData),
        );
        const [, , , form] = (vikunjaRestMultipartRequest as jest.Mock).mock.calls[0] as [
          unknown,
          unknown,
          unknown,
          FormData,
        ];
        const entry = form.get('avatar') as File;
        expect(entry.name).toBe(basename(tmp));

        const markdown = result.content[0].text;
        expect(markdown).toContain("provider set to 'upload'");
        expect(markdown).toContain(`**filename:** ${basename(tmp)}`);
        expect(markdown).toContain('**source:** filePath');
      } finally {
        unlinkSync(tmp);
      }
    });

    it('should decode base64 fileContent with a default filename', async () => {
      (vikunjaRestMultipartRequest as jest.Mock).mockResolvedValue({ message: 'Success' });

      const result = await callTool('upload-avatar', { fileContent: 'aGkK' });

      const markdown = result.content[0].text;
      expect(markdown).toContain('**filename:** avatar.png');
      expect(markdown).toContain('**source:** fileContent');
    });

    it('should use explicit filename and strip directory components', async () => {
      (vikunjaRestMultipartRequest as jest.Mock).mockResolvedValue({ message: 'Success' });

      const result = await callTool('upload-avatar', {
        fileContent: 'aGkK',
        filename: '/etc/me.jpg',
      });

      const markdown = result.content[0].text;
      expect(markdown).toContain('**filename:** me.jpg');
    });

    it('should let filePath take precedence over fileContent', async () => {
      const tmp = join(tmpdir(), `avatar-priority-${Date.now()}-${process.pid}.png`);
      writeFileSync(tmp, 'from-path'); // 9 bytes
      try {
        (vikunjaRestMultipartRequest as jest.Mock).mockResolvedValue({ message: 'Success' });
        const result = await callTool('upload-avatar', {
          filePath: tmp,
          fileContent: 'd3JvbmcK',
          filename: 'override.png',
        });

        const markdown = result.content[0].text;
        expect(markdown).toContain('**source:** filePath');
        expect(markdown).toContain('**bytes:** 9');
      } finally {
        unlinkSync(tmp);
      }
    });

    it('throws explanatory error when filePath does not exist', async () => {
      await expect(
        callTool('upload-avatar', { filePath: '/no/such/dir/xyz-avatar-test.bin' }),
      ).rejects.toThrow(
        /^upload-avatar: cannot read filePath \/no\/such\/dir\/xyz-avatar-test\.bin:/,
      );
    });

    it('should handle API errors', async () => {
      (vikunjaRestMultipartRequest as jest.Mock).mockRejectedValue(new Error('Upload failed'));

      await expect(callTool('upload-avatar', { fileContent: 'aGkK' })).rejects.toThrow(
        'User operation error: Upload failed',
      );
    });
  });

  describe('invalid subcommand', () => {
    it('should reject invalid subcommands', async () => {
      await expect(callTool('invalid')).rejects.toThrow('Invalid subcommand: invalid');
    });
  });

  describe('error handling', () => {
    it('should pass through MCPError instances', async () => {
      const customError = new MCPError(ErrorCode.API_ERROR, 'Custom error');
      (vikunjaRestRequest as jest.Mock).mockRejectedValue(customError);

      await expect(callTool('current')).rejects.toThrow('Custom error');
    });

    it('should handle non-MCPError objects in catch block', async () => {
      (vikunjaRestRequest as jest.Mock).mockRejectedValue(new Error('Unexpected error'));

      await expect(callTool('current')).rejects.toThrow('User operation error: Unexpected error');
    });

    it('should handle non-Error thrown values in main handler', async () => {
      (vikunjaRestRequest as jest.Mock).mockRejectedValue('String error thrown');

      await expect(callTool('current')).rejects.toThrow(
        'User operation error: String error thrown',
      );
    });

    it('should handle authentication errors for current user endpoint (documented Vikunja API limitation, see docs/API_NOTES.md)', async () => {
      // vikunjaRestRequest throws MCPError with details.statusCode set from
      // the HTTP response, not a `.message` string — this is the documented
      // "same token works everywhere except /user" quirk (API_NOTES.md
      // "User Endpoint Authentication"), detected structurally in the
      // catch block (see src/tools/users.ts) rather than by message pattern.
      (vikunjaRestRequest as jest.Mock).mockRejectedValue(
        new MCPError(
          ErrorCode.API_ERROR,
          'Vikunja REST request failed (GET /user): HTTP 401 Unauthorized',
          {
            statusCode: 401,
          },
        ),
      );

      await expect(callTool('current')).rejects.toThrow(
        'User endpoint authentication error. This is a known Vikunja API limitation. ' +
          'User endpoints require JWT authentication instead of API tokens. ' +
          'To use user operations, connect with a JWT token (starting with eyJ).',
      );
    });

    it('should handle token-related errors for current user endpoint', async () => {
      (vikunjaRestRequest as jest.Mock).mockRejectedValue(new Error('Token validation failed'));

      await expect(callTool('current')).rejects.toThrow(
        'User operation error: Token validation failed',
      );
    });

    it('should handle auth errors for search operation', async () => {
      (vikunjaRestRequest as jest.Mock).mockRejectedValue(
        new MCPError(
          ErrorCode.API_ERROR,
          'Vikunja REST request failed (GET /users): HTTP 403 Forbidden',
          {
            statusCode: 403,
          },
        ),
      );

      await expect(callTool('search')).rejects.toThrow(
        'User endpoint authentication error. This is a known Vikunja API limitation.',
      );
    });

    it('should handle auth errors for settings operation', async () => {
      (vikunjaRestRequest as jest.Mock).mockRejectedValue(
        new MCPError(
          ErrorCode.API_ERROR,
          'Vikunja REST request failed (GET /user): HTTP 401 Unauthorized',
          {
            statusCode: 401,
          },
        ),
      );

      await expect(callTool('settings')).rejects.toThrow(
        'User endpoint authentication error. This is a known Vikunja API limitation.',
      );
    });

    it('should handle auth errors for update-settings operation', async () => {
      (vikunjaRestRequest as jest.Mock).mockRejectedValue(
        new MCPError(
          ErrorCode.API_ERROR,
          'Vikunja REST request failed (POST /user/settings/general): HTTP 401 Unauthorized — token expired',
          { statusCode: 401 },
        ),
      );

      await expect(callTool('update-settings', { name: 'New Name' })).rejects.toThrow(
        'JWT token has expired',
      );
    });
  });

  describe('default subcommand', () => {
    it('should throw validation error when no subcommand provided', async () => {
      // subcommand is a required field (see src/tools/users.ts) - the MCP SDK's
      // Zod validation rejects calls with a missing subcommand before the handler
      // ever runs. This test exercises the handler's own defensive default case
      // for the same scenario (e.g. if invoked directly bypassing SDK validation).
      await expect(callTool()).rejects.toThrow('Invalid subcommand: undefined');
    });
  });

  describe('tool registration', () => {
    it('should register the vikunja_users tool', () => {
      expect(mockServer.tool).toHaveBeenCalledWith(
        'vikunja_users',
        expect.stringContaining('Manage user profiles, search users, and update user settings'),
        expect.any(Object), // Zod schema
        expect.any(Object), // ToolAnnotations
        expect.any(Function), // Handler function
      );
    });

    it('should have the correct tool handler', () => {
      expect(toolHandler).toBeDefined();
      expect(typeof toolHandler).toBe('function');
    });
  });

  describe('global read-only mode', () => {
    afterEach(() => {
      ConfigurationManager.reset();
    });

    it('rejects update-settings when readOnly is on', async () => {
      ConfigurationManager.reset();
      ConfigurationManager.getInstance({ sources: { readOnly: true } });

      expect(
        isReadOnlyRejection(
          await callAndCatch(toolHandler, { subcommand: 'update-settings', name: 'x' }),
        ),
      ).toBe(true);
    });

    it('rejects set-avatar and upload-avatar when readOnly is on', async () => {
      ConfigurationManager.reset();
      ConfigurationManager.getInstance({ sources: { readOnly: true } });

      expect(
        isReadOnlyRejection(
          await callAndCatch(toolHandler, { subcommand: 'set-avatar', avatarProvider: 'gravatar' }),
        ),
      ).toBe(true);
      expect(
        isReadOnlyRejection(
          await callAndCatch(toolHandler, { subcommand: 'upload-avatar', fileContent: 'aGkK' }),
        ),
      ).toBe(true);
      expect(vikunjaRestRequest).not.toHaveBeenCalled();
      expect(vikunjaRestMultipartRequest).not.toHaveBeenCalled();
    });

    it('does not raise the read-only error for current/search/settings/timezones/get-avatar when readOnly is on', async () => {
      ConfigurationManager.reset();
      ConfigurationManager.getInstance({ sources: { readOnly: true } });

      expect(isReadOnlyRejection(await callAndCatch(toolHandler, { subcommand: 'current' }))).toBe(
        false,
      );
      expect(isReadOnlyRejection(await callAndCatch(toolHandler, { subcommand: 'search' }))).toBe(
        false,
      );
      expect(isReadOnlyRejection(await callAndCatch(toolHandler, { subcommand: 'settings' }))).toBe(
        false,
      );
      expect(
        isReadOnlyRejection(await callAndCatch(toolHandler, { subcommand: 'timezones' })),
      ).toBe(false);
      expect(
        isReadOnlyRejection(await callAndCatch(toolHandler, { subcommand: 'get-avatar' })),
      ).toBe(false);
    });

    it('does not raise the read-only error for update-settings when readOnly is off', async () => {
      ConfigurationManager.reset();
      ConfigurationManager.getInstance({ sources: { readOnly: false } });

      expect(
        isReadOnlyRejection(
          await callAndCatch(toolHandler, { subcommand: 'update-settings', name: 'x' }),
        ),
      ).toBe(false);
    });
  });
});
