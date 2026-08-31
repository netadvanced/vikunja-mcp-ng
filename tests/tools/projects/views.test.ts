/**
 * Tests for project view operations (`list-views`, `get-view`,
 * `create-view`, `update-view`, `delete-view`, `set-done-bucket`).
 *
 * Covers id validation, request path/verb correctness against the real
 * spec shapes, fetch-merge-POST payload assertions for the full-model-
 * replace update endpoint, verify-then-report behavior for
 * `set-done-bucket`, and error propagation.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AuthManager } from '../../../src/auth/AuthManager';
import {
  listViews,
  getView,
  createView,
  updateView,
  deleteView,
  setDoneBucket,
  buildViewUpdatePayload,
} from '../../../src/tools/projects/views';
import { MCPError, ErrorCode } from '../../../src/types';
import { circuitBreakerRegistry } from '../../../src/utils/retry';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** Minimal Response-like object for the REST helper. */
function mockResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  text?: string;
}): Response {
  const { ok = true, status = 200, statusText = 'OK', text = '' } = opts;
  return {
    ok,
    status,
    statusText,
    text: jest.fn(async () => text),
  } as unknown as Response;
}

/** A views payload matching the real ProjectView response shape. */
const viewsPayload = JSON.stringify([
  { id: 10, title: 'List', project_id: 5, view_kind: 'list', position: 1 },
  {
    id: 11,
    title: 'Kanban',
    project_id: 5,
    view_kind: 'kanban',
    position: 2,
    bucket_configuration_mode: 'manual',
    default_bucket_id: 100,
    done_bucket_id: 101,
  },
]);

const kanbanView = {
  id: 11,
  title: 'Kanban',
  project_id: 5,
  view_kind: 'kanban' as const,
  position: 2,
  bucket_configuration_mode: 'manual' as const,
  default_bucket_id: 100,
  done_bucket_id: 101,
};

describe('project views', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  describe('listViews', () => {
    it('throws a VALIDATION_ERROR when the project id is missing', async () => {
      await expect(listViews({}, authManager)).rejects.toThrow(
        new MCPError(ErrorCode.VALIDATION_ERROR, 'Project id is required for list-views operation'),
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws when the project id is not a positive integer', async () => {
      await expect(listViews({ id: -3 }, authManager)).rejects.toThrow(
        'id must be a positive integer',
      );
    });

    it('lists views with their view kind and bucket configuration fields', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ text: viewsPayload }));

      const result = await listViews({ id: 5 }, authManager);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe('https://vikunja.test/api/v1/projects/5/views');

      const text = result.content[0].text;
      expect(text).toContain('Found 2 views for project 5');
      expect(text).toContain('"viewKind": "kanban"');
      expect(text).toContain('"doneBucketId": 101');
      expect(text).toContain('"defaultBucketId": 100');
    });

    it('treats a non-array response as an empty list', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ text: '' }));

      const result = await listViews({ id: 5 }, authManager);

      expect(result.content[0].text).toContain('Found 0 views');
    });
  });

  describe('getView', () => {
    it('throws a VALIDATION_ERROR when the project id is missing', async () => {
      await expect(getView({ viewId: 11 }, authManager)).rejects.toThrow(
        'Project id is required for get-view operation',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws a VALIDATION_ERROR when the view id is missing', async () => {
      await expect(getView({ id: 5 }, authManager)).rejects.toThrow(
        'View id is required for get-view operation',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws when the view id is not a positive integer', async () => {
      await expect(getView({ id: 5, viewId: 0 }, authManager)).rejects.toThrow(
        'viewId must be a positive integer',
      );
    });

    it('fetches a single view by id', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ text: JSON.stringify(kanbanView) }));

      const result = await getView({ id: 5, viewId: 11 }, authManager);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe('https://vikunja.test/api/v1/projects/5/views/11');
      expect(result.content[0].text).toContain('Retrieved view 11 of project 5');
      expect(result.content[0].text).toContain('"viewKind": "kanban"');
    });
  });

  describe('createView', () => {
    it('throws a VALIDATION_ERROR when the project id is missing', async () => {
      await expect(
        createView({ title: 'New View', viewKind: 'list' }, authManager),
      ).rejects.toThrow('Project id is required for create-view operation');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws a VALIDATION_ERROR when title is missing', async () => {
      await expect(createView({ id: 5, viewKind: 'list' }, authManager)).rejects.toThrow(
        'title is required for create-view operation',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws a VALIDATION_ERROR when viewKind is missing', async () => {
      await expect(createView({ id: 5, title: 'New View' }, authManager)).rejects.toThrow(
        'viewKind is required for create-view operation',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sends a PUT with the exact title/view_kind payload', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          text: JSON.stringify({ id: 20, title: 'New View', view_kind: 'list', project_id: 5 }),
        }),
      );

      const result = await createView(
        { id: 5, title: '  New View  ', viewKind: 'list' },
        authManager,
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://vikunja.test/api/v1/projects/5/views');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ title: 'New View', view_kind: 'list' }));
      expect(result.content[0].text).toContain('View "New View" created on project 5');
    });

    it('includes bucket_configuration_mode in the payload when provided', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          text: JSON.stringify({ id: 21, title: 'Board', view_kind: 'kanban', project_id: 5 }),
        }),
      );

      await createView(
        { id: 5, title: 'Board', viewKind: 'kanban', bucketConfigurationMode: 'manual' },
        authManager,
      );

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBe(
        JSON.stringify({
          title: 'Board',
          view_kind: 'kanban',
          bucket_configuration_mode: 'manual',
        }),
      );
    });
  });

  describe('buildViewUpdatePayload', () => {
    it('preserves untouched fields and only overlays requested changes', () => {
      const payload = buildViewUpdatePayload(kanbanView, { doneBucketId: 999 });

      expect(payload).toEqual({ ...kanbanView, done_bucket_id: 999 });
    });
  });

  describe('updateView', () => {
    it('throws a VALIDATION_ERROR when the project id is missing', async () => {
      await expect(updateView({ viewId: 11, title: 'x' }, authManager)).rejects.toThrow(
        'Project id is required for update-view operation',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws a VALIDATION_ERROR when the view id is missing', async () => {
      await expect(updateView({ id: 5, title: 'x' }, authManager)).rejects.toThrow(
        'View id is required for update-view operation',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws a VALIDATION_ERROR when no update fields are provided', async () => {
      await expect(updateView({ id: 5, viewId: 11 }, authManager)).rejects.toThrow(
        'No fields to update provided for update-view operation',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws when doneBucketId is not a positive integer', async () => {
      await expect(updateView({ id: 5, viewId: 11, doneBucketId: 0 }, authManager)).rejects.toThrow(
        'doneBucketId must be a positive integer',
      );
    });

    it('fetches the current view, merges the change, and POSTs the full model', async () => {
      // 1) GET current view  2) POST merged payload
      mockFetch
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(kanbanView) }))
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ ...kanbanView, done_bucket_id: 202 }) }),
        );

      const result = await updateView({ id: 5, viewId: 11, doneBucketId: 202 }, authManager);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const urls = mockFetch.mock.calls.map((c) => c[0]);
      expect(urls[0]).toBe('https://vikunja.test/api/v1/projects/5/views/11');
      expect(urls[1]).toBe('https://vikunja.test/api/v1/projects/5/views/11');

      const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(postInit.method).toBe('POST');
      // The full merged model is sent -- title/view_kind/etc. from the
      // current view survive even though only doneBucketId was requested.
      expect(postInit.body).toBe(JSON.stringify({ ...kanbanView, done_bucket_id: 202 }));

      expect(result.content[0].text).toContain('View 11 of project 5 updated');
    });

    it('trims and merges a title change while preserving other fields', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(kanbanView) }))
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ ...kanbanView, title: 'Renamed' }) }),
        );

      await updateView({ id: 5, viewId: 11, title: '  Renamed  ' }, authManager);

      const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(postInit.body).toBe(JSON.stringify({ ...kanbanView, title: 'Renamed' }));
    });
  });

  /**
   * Silent field-drop regression guards for the view write paths.
   *
   * `position`, `filter`, and `bucket_configuration` are all real
   * `models.ProjectView` fields (vendored spec + go-vikunja
   * `pkg/models/project_view.go`) that this tool used to accept and throw
   * away. `position` was the worst of the three: `viewSummary` echoed the
   * SERVER's position straight back, so a caller reordering views got a
   * no-op plus a response that looked like it had worked.
   *
   * Every test here asserts the outgoing WIRE body, and the falsy values
   * (`position: 0`) are covered explicitly — a naive `if (args.position)`
   * guard drops exactly those.
   */
  describe('silently-dropped view fields', () => {
    describe('createView', () => {
      it('sends position on the wire', async () => {
        mockFetch.mockResolvedValueOnce(
          mockResponse({
            text: JSON.stringify({ id: 22, title: 'Second', view_kind: 'list', position: 250 }),
          }),
        );

        await createView({ id: 5, title: 'Second', viewKind: 'list', position: 250 }, authManager);

        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(init.body).toBe(
          JSON.stringify({ title: 'Second', view_kind: 'list', position: 250 }),
        );
      });

      it('sends position 0 rather than dropping it as falsy', async () => {
        mockFetch.mockResolvedValueOnce(
          mockResponse({
            text: JSON.stringify({ id: 23, title: 'First', view_kind: 'list', position: 1507328 }),
          }),
        );

        await createView({ id: 5, title: 'First', viewKind: 'list', position: 0 }, authManager);

        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toHaveProperty('position', 0);
      });

      it('sends filter as the nested TaskCollection the model actually uses', async () => {
        mockFetch.mockResolvedValueOnce(
          mockResponse({
            text: JSON.stringify({ id: 24, title: 'Open', view_kind: 'list' }),
          }),
        );

        await createView(
          { id: 5, title: 'Open', viewKind: 'list', filter: 'done = false' },
          authManager,
        );

        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({
          title: 'Open',
          view_kind: 'list',
          filter: { filter: 'done = false' },
        });
      });

      it('translates DSL field names to the API field names Vikunja expects', async () => {
        mockFetch.mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ id: 25, title: 'Soon', view_kind: 'list' }) }),
        );

        await createView(
          { id: 5, title: 'Soon', viewKind: 'list', filter: 'dueDate < now' },
          authManager,
        );

        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(
          (JSON.parse(String(init.body)) as { filter: { filter: string } }).filter.filter,
        ).toContain('due_date');
      });

      it('rejects an unparseable filter before any API call', async () => {
        await expect(
          createView(
            { id: 5, title: 'Bad', viewKind: 'list', filter: 'done ?? nope' },
            authManager,
          ),
        ).rejects.toThrow(/Invalid filter/);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('sends bucket_configuration so a filter-mode board has columns', async () => {
        mockFetch.mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ id: 26, title: 'Board', view_kind: 'kanban' }) }),
        );

        await createView(
          {
            id: 5,
            title: 'Board',
            viewKind: 'kanban',
            bucketConfigurationMode: 'filter',
            bucketConfiguration: [
              { title: 'Urgent', filter: 'priority >= 4' },
              { title: 'Everything else' },
            ],
          },
          authManager,
        );

        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({
          title: 'Board',
          view_kind: 'kanban',
          bucket_configuration_mode: 'filter',
          bucket_configuration: [
            { title: 'Urgent', filter: { filter: 'priority >= 4' } },
            { title: 'Everything else' },
          ],
        });
      });

      it('rejects a bucketConfiguration entry with a blank title, naming the index', async () => {
        await expect(
          createView(
            {
              id: 5,
              title: 'Board',
              viewKind: 'kanban',
              bucketConfiguration: [{ title: 'ok' }, { title: '  ' }],
            },
            authManager,
          ),
        ).rejects.toThrow('bucketConfiguration[1].title is required');
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('REJECTS doneBucketId with a pointer to the tools that can set it', async () => {
        await expect(
          createView({ id: 5, title: 'Board', viewKind: 'kanban', doneBucketId: 101 }, authManager),
        ).rejects.toThrow(MCPError);
        await expect(
          createView({ id: 5, title: 'Board', viewKind: 'kanban', doneBucketId: 101 }, authManager),
        ).rejects.toThrow(/doneBucketId cannot be set by create-view[\s\S]*update-view/);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('REJECTS defaultBucketId, and names both fields when both are given', async () => {
        await expect(
          createView(
            {
              id: 5,
              title: 'Board',
              viewKind: 'kanban',
              doneBucketId: 101,
              defaultBucketId: 100,
            },
            authManager,
          ),
        ).rejects.toThrow(/doneBucketId and defaultBucketId cannot be set by create-view/);
        expect(mockFetch).not.toHaveBeenCalled();
      });
    });

    describe('updateView', () => {
      it('accepts position alone as an update field and sends it merged', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(kanbanView) }))
          .mockResolvedValueOnce(
            mockResponse({ text: JSON.stringify({ ...kanbanView, position: 999 }) }),
          );

        await updateView({ id: 5, viewId: 11, position: 999 }, authManager);

        const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
        expect(postInit.body).toBe(JSON.stringify({ ...kanbanView, position: 999 }));
      });

      it('sends position 0 rather than dropping it as falsy', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(kanbanView) }))
          .mockResolvedValueOnce(
            mockResponse({ text: JSON.stringify({ ...kanbanView, position: 0 }) }),
          );

        await updateView({ id: 5, viewId: 11, position: 0 }, authManager);

        const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
        expect(JSON.parse(String(postInit.body))).toHaveProperty('position', 0);
      });

      it("preserves the view's position when the caller only renames it", async () => {
        // go-vikunja's ProjectView.Update names "position" in its explicit
        // Cols(...) list, so a partial body would write 0 and reshuffle the
        // whole view order. The fetch-merge-POST is what stops that.
        mockFetch
          .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(kanbanView) }))
          .mockResolvedValueOnce(
            mockResponse({ text: JSON.stringify({ ...kanbanView, title: 'Renamed' }) }),
          );

        await updateView({ id: 5, viewId: 11, title: 'Renamed' }, authManager);

        const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
        expect(JSON.parse(String(postInit.body))).toHaveProperty('position', kanbanView.position);
      });

      it('merges a new filter query onto the existing TaskCollection', async () => {
        const filteredView = {
          ...kanbanView,
          filter: { filter: 'done = false', sort_by: ['priority'] },
        };
        mockFetch
          .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(filteredView) }))
          .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(filteredView) }));

        await updateView({ id: 5, viewId: 11, filter: 'priority >= 4' }, authManager);

        const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
        expect(JSON.parse(String(postInit.body)).filter).toEqual({
          filter: 'priority >= 4',
          sort_by: ['priority'],
        });
      });

      it('sends bucket_configuration when it changes', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(kanbanView) }))
          .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(kanbanView) }));

        await updateView(
          {
            id: 5,
            viewId: 11,
            bucketConfigurationMode: 'filter',
            bucketConfiguration: [{ title: 'Urgent', filter: 'priority >= 4' }],
          },
          authManager,
        );

        const [, postInit] = mockFetch.mock.calls[1] as [string, RequestInit];
        expect(JSON.parse(String(postInit.body))).toMatchObject({
          bucket_configuration_mode: 'filter',
          bucket_configuration: [{ title: 'Urgent', filter: { filter: 'priority >= 4' } }],
        });
      });

      it('reports position and filter as affected fields', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(kanbanView) }))
          .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(kanbanView) }));

        const result = await updateView(
          { id: 5, viewId: 11, position: 42, filter: 'done = false' },
          authManager,
        );

        expect(result.content[0].text).toContain('position');
        expect(result.content[0].text).toContain('filter');
      });
    });

    describe('buildViewUpdatePayload', () => {
      it('overlays position 0 instead of treating it as absent', () => {
        expect(buildViewUpdatePayload(kanbanView, { position: 0 })).toEqual({
          ...kanbanView,
          position: 0,
        });
      });

      it('keeps the rest of an existing filter collection when only the query changes', () => {
        const withFilter = {
          ...kanbanView,
          filter: { filter: 'done = false', order_by: ['desc'] },
        };
        expect(buildViewUpdatePayload(withFilter, { filter: 'done = true' }).filter).toEqual({
          filter: 'done = true',
          order_by: ['desc'],
        });
      });
    });
  });

  describe('deleteView', () => {
    it('throws a VALIDATION_ERROR when the project id is missing', async () => {
      await expect(deleteView({ viewId: 11 }, authManager)).rejects.toThrow(
        'Project id is required for delete-view operation',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws a VALIDATION_ERROR when the view id is missing', async () => {
      await expect(deleteView({ id: 5 }, authManager)).rejects.toThrow(
        'View id is required for delete-view operation',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sends a DELETE to the view path', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ text: JSON.stringify({ message: 'ok' }) }));

      const result = await deleteView({ id: 5, viewId: 11 }, authManager);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://vikunja.test/api/v1/projects/5/views/11');
      expect(init.method).toBe('DELETE');
      expect(result.content[0].text).toContain('View 11 of project 5 deleted');
    });
  });

  describe('setDoneBucket', () => {
    it('throws a VALIDATION_ERROR when the project id is missing', async () => {
      await expect(setDoneBucket({ bucketId: 101 }, authManager)).rejects.toThrow(
        'Project id is required for set-done-bucket operation',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws a VALIDATION_ERROR when bucketId is missing', async () => {
      await expect(setDoneBucket({ id: 5 }, authManager)).rejects.toThrow(
        'bucketId is required for set-done-bucket operation',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('resolves the Kanban view id when viewId is omitted', async () => {
      // 1) GET /projects/:id/views (resolve kanban) 2) GET view 3) POST merged view
      mockFetch
        .mockResolvedValueOnce(mockResponse({ text: viewsPayload }))
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(kanbanView) }))
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ ...kanbanView, done_bucket_id: 100 }) }),
        );

      const result = await setDoneBucket({ id: 5, bucketId: 100 }, authManager);

      expect(mockFetch).toHaveBeenCalledTimes(3);
      const urls = mockFetch.mock.calls.map((c) => c[0]);
      expect(urls[0]).toBe('https://vikunja.test/api/v1/projects/5/views');
      expect(urls[1]).toBe('https://vikunja.test/api/v1/projects/5/views/11');
      expect(urls[2]).toBe('https://vikunja.test/api/v1/projects/5/views/11');

      const [, postInit] = mockFetch.mock.calls[2] as [string, RequestInit];
      expect(postInit.method).toBe('POST');
      expect(postInit.body).toBe(JSON.stringify({ ...kanbanView, done_bucket_id: 100 }));

      expect(result.content[0].text).toContain(
        'Bucket 100 set as the done bucket for view 11 of project 5',
      );
    });

    it('uses an explicit viewId without resolving the Kanban view', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(kanbanView) }))
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ ...kanbanView, done_bucket_id: 100 }) }),
        );

      await setDoneBucket({ id: 5, viewId: 11, bucketId: 100 }, authManager);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const urls = mockFetch.mock.calls.map((c) => c[0]);
      expect(urls[0]).toBe('https://vikunja.test/api/v1/projects/5/views/11');
      expect(urls[1]).toBe('https://vikunja.test/api/v1/projects/5/views/11');
    });

    it('throws an API_ERROR when the server does not reflect the requested done bucket', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(kanbanView) }))
        // Server echoes back the OLD done_bucket_id instead of the new one.
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(kanbanView) }));

      await expect(
        setDoneBucket({ id: 5, viewId: 11, bucketId: 999 }, authManager),
      ).rejects.toThrow(/expected done_bucket_id 999, server reports 101/);
    });

    it('propagates an HTTP error from the update request', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(kanbanView) }))
        .mockResolvedValueOnce(
          mockResponse({ ok: false, status: 400, statusText: 'Bad Request', text: 'invalid view' }),
        );

      await expect(
        setDoneBucket({ id: 5, viewId: 11, bucketId: 100 }, authManager),
      ).rejects.toThrow(MCPError);
    });
  });
});
