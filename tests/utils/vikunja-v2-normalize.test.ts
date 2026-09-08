/**
 * Tests for the Vikunja v2 response normalizer
 * (src/utils/vikunja-v2-normalize.ts).
 *
 * Every envelope in here is a real response body captured with curl from the
 * running e2e stacks on 2026-09-05 (2.4.0 :9240, 2.5.0 :9250, 2.6.0 :9260),
 * trimmed only by dropping list entries and by replacing bucket `tasks` arrays
 * with a placeholder. Nothing here is an invented fixture, because the whole
 * point of this boundary is that it matches what the servers actually send.
 */

import { describe, it, expect } from '@jest/globals';
import { normalizeV2Response, getV2PaginationMeta } from '../../src/utils/vikunja-v2-normalize';

/** GET /api/v2/labels?per_page=1 on 2.6.0. */
const LABELS_ENVELOPE = {
  $schema: 'http://localhost:9260/api/v2/schemas/PaginatedLabelWithTaskID.json',
  items: [
    {
      id: 4,
      title: 'mcp-e2e-mtjcgt4mey-multi-tag',
      description: '',
      hex_color: '',
      created_by: {
        id: 1,
        name: '',
        username: 'e2e-test',
        created: '2026-09-02T00:13:31Z',
        updated: '2026-09-02T00:13:31Z',
      },
      created: '2026-09-02T00:14:56Z',
      updated: '2026-09-02T00:14:56Z',
    },
  ],
  total: 15,
  page: 1,
  per_page: 1,
  total_pages: 15,
};

/** GET /api/v2/projects?page=999 on 2.6.0, a valid request past the last page. */
const EMPTY_ENVELOPE = {
  $schema: 'http://localhost:9260/api/v2/schemas/PaginatedProject.json',
  items: [],
  total: 17,
  page: 999,
  per_page: 50,
  total_pages: 1,
};

/**
 * GET /api/v2/projects/{id}/views/{kanban view}/buckets/tasks on 2.6.0.
 *
 * The one enveloped response in the whole v2 surface that carries no
 * `page`/`per_page`/`total_pages`: its schema is `BucketsWithTasksBodyBody`,
 * `{$schema, items, total}`. Confirmed live on 2.4.0 and 2.6.0, and it is the
 * only non-`Paginated*` schema in docs/vikunja-openapi-v2.json with an `items`
 * property.
 */
const BUCKETS_ENVELOPE = {
  $schema: 'http://localhost:9260/api/v2/schemas/BucketsWithTasksBodyBody.json',
  items: [
    {
      id: 193,
      title: 'To-Do',
      project_view_id: 260,
      tasks: [],
      limit: 0,
      count: 1,
      position: 100,
      created: '2026-09-05T11:30:26Z',
      updated: '2026-09-05T11:30:26Z',
    },
    {
      id: 194,
      title: 'Doing',
      project_view_id: 260,
      limit: 0,
      count: 0,
      position: 200,
      created: '2026-09-05T11:30:26Z',
      updated: '2026-09-05T11:30:26Z',
    },
  ],
  total: 2,
};

/** GET /api/v2/projects/{id} on 2.6.0, `views` dropped for length. */
const SINGLE_PROJECT = {
  $schema: 'http://localhost:9260/api/v2/schemas/ProjectReadBody.json',
  id: 60,
  title: 'mcp-e2e-mtoax2izcd-a6-proj',
  description: '',
  identifier: '',
  hex_color: '',
  parent_project_id: 0,
  owner: {
    id: 1,
    name: '',
    username: 'e2e-test',
    created: '2026-09-02T00:13:31Z',
    updated: '2026-09-02T00:13:31Z',
  },
  is_archived: false,
  background_information: null,
  background_blur_hash: '',
  is_favorite: false,
  position: 3932160,
  max_permission: 2,
  created: '2026-09-05T11:30:26Z',
  updated: '2026-09-05T11:30:27Z',
};

/** Re-parses a captured body so each test works on its own object graph. */
function body<T>(captured: T): unknown {
  return JSON.parse(JSON.stringify(captured)) as unknown;
}

describe('normalizeV2Response', () => {
  describe('pagination envelopes', () => {
    it('unwraps a populated envelope to the bare array v1 callers expect', () => {
      const result = normalizeV2Response(body(LABELS_ENVELOPE));

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect((result as Array<{ title: string }>)[0]?.title).toBe('mcp-e2e-mtjcgt4mey-multi-tag');
    });

    it('leaves no trace of the envelope on the normalized result', () => {
      const result = normalizeV2Response(body(LABELS_ENVELOPE));

      // The whole contract: downstream cannot tell which API version ran.
      expect(JSON.stringify(result)).not.toContain('$schema');
      expect(JSON.stringify(result)).not.toContain('total_pages');
    });

    it('captures total and total_pages as out-of-band metadata', () => {
      const result = normalizeV2Response(body(LABELS_ENVELOPE));

      expect(getV2PaginationMeta(result)).toEqual({
        total: 15,
        page: 1,
        perPage: 1,
        totalPages: 15,
      });
    });

    it('returns the envelope items array itself rather than a copy', () => {
      const parsed = body(LABELS_ENVELOPE) as { items: unknown[] };

      expect(normalizeV2Response(parsed)).toBe(parsed.items);
    });

    it('unwraps an envelope with zero items to an empty array', () => {
      const result = normalizeV2Response(body(EMPTY_ENVELOPE));

      expect(result).toEqual([]);
      expect(getV2PaginationMeta(result)).toEqual({
        total: 17,
        page: 999,
        perPage: 50,
        totalPages: 1,
      });
    });

    it('unwraps the buckets envelope, which carries only total', () => {
      const result = normalizeV2Response(body(BUCKETS_ENVELOPE));

      expect(result).toHaveLength(2);
      expect(getV2PaginationMeta(result)).toEqual({ total: 2 });
    });

    it('ignores pagination fields that are not numbers', () => {
      // A proxy or a future server sending `total` as a string must not put a
      // string into the metadata record, but must still unwrap: `page` is
      // enough to recognize the envelope.
      const result = normalizeV2Response({
        $schema: 'https://vikunja.test/api/v2/schemas/PaginatedProject.json',
        items: [{ id: 1 }],
        total: '17',
        page: 1,
      });

      expect(result).toEqual([{ id: 1 }]);
      expect(getV2PaginationMeta(result)).toEqual({ page: 1 });
    });
  });

  describe('single-entity responses', () => {
    it('strips $schema and leaves every other field untouched', () => {
      const result = normalizeV2Response(body(SINGLE_PROJECT));
      const { $schema: _schema, ...expected } = SINGLE_PROJECT;

      expect(result).toEqual(expected);
      expect(result).not.toHaveProperty('$schema');
    });

    it('records no pagination metadata for a single entity', () => {
      expect(getV2PaginationMeta(normalizeV2Response(body(SINGLE_PROJECT)))).toBeUndefined();
    });

    it('returns an object with no $schema unchanged', () => {
      const parsed = body({ id: 7, title: 'no schema key' });

      expect(normalizeV2Response(parsed)).toBe(parsed);
    });

    it('does not unwrap an object whose items array has no pagination fields', () => {
      // No such response exists in the v2 spec today, but treating any `items`
      // array as an envelope would silently swallow the rest of such a body.
      const parsed = { $schema: 'https://vikunja.test/x.json', items: [1, 2], id: 9 };

      expect(normalizeV2Response(parsed)).toEqual({ items: [1, 2], id: 9 });
    });
  });

  describe('bodies that need no normalization', () => {
    it('passes a bare array through unchanged', () => {
      // Defensive: a caching proxy, or a future version, could serve a v1-shaped
      // list on a v2 path.
      const parsed = body([{ id: 1 }, { id: 2 }]) as unknown[];

      expect(normalizeV2Response(parsed)).toBe(parsed);
      expect(getV2PaginationMeta(parsed)).toBeUndefined();
    });

    it('passes null through unchanged', () => {
      expect(normalizeV2Response(null)).toBeNull();
    });

    it('passes primitives through unchanged', () => {
      expect(normalizeV2Response('done')).toBe('done');
      expect(normalizeV2Response(42)).toBe(42);
      expect(normalizeV2Response(undefined)).toBeUndefined();
    });
  });

  describe('getV2PaginationMeta', () => {
    it('returns undefined for a value the normalizer never saw', () => {
      expect(getV2PaginationMeta([{ id: 1 }])).toBeUndefined();
    });

    it('returns undefined for non-objects', () => {
      expect(getV2PaginationMeta(null)).toBeUndefined();
      expect(getV2PaginationMeta('items')).toBeUndefined();
      expect(getV2PaginationMeta(undefined)).toBeUndefined();
    });
  });
});
