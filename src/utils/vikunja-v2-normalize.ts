/**
 * Vikunja v2 response normalization: the boundary that makes the rest of the
 * codebase version-blind.
 *
 * v2 list endpoints answer with an object envelope where v1 answers with a
 * bare array. Confirmed byte-for-byte against the running 2.4.0, 2.5.0 and
 * 2.6.0 stacks on 2026-09-05:
 *
 *     {$schema, items, total, page, per_page, total_pages}
 *
 * with one documented exception: the kanban
 * `GET /projects/{id}/views/{view}/buckets/tasks` route answers with
 * `BucketsWithTasksBodyBody`, `{$schema, items, total}` and no page fields at
 * all (verified live on 2.4.0 and 2.6.0). Single-entity reads are not
 * enveloped, but they do carry a top-level `$schema` of their own.
 *
 * Normalizing here means formatters, tool handlers and tests never learn which
 * API version served a request. That principle is not new: P1 established it
 * for errors, where both transports converge on `MCPError` and every catch
 * block in the codebase is already version-blind. This extends the same
 * treatment to response bodies, per the "Normalization at the strategy
 * boundary" section of
 * docs/superpowers/specs/2026-08-02-vikunja-v2-native-adoption-design.md.
 *
 * Deliberately a standalone pure function rather than logic buried inside
 * `vikunjaRestV2Request`: the later P3 steps introduce per-operation
 * strategies, and a strategy that wants the envelope (to page through it, say)
 * must be able to opt out of normalization and still reuse the unwrapping
 * rules. `vikunjaRestV2Request` applies this by default and takes a
 * `normalize: false` escape hatch; a strategy can call this function directly
 * on a body it fetched raw.
 *
 * Out of scope on purpose: mapping the `s` search parameter to v2's `q`. That
 * is operation-specific rather than envelope-shaped, and the spec places it
 * inside the v2 strategies that search.
 */

/**
 * Pagination counters lifted off a v2 envelope.
 *
 * Camel-cased rather than kept in the wire's snake_case because this is our own
 * internal record, not a Vikunja model: nothing serializes it, and no caller
 * sees it. Every field is optional because the buckets envelope carries only
 * `total`, and because a proxy can send anything.
 */
export interface V2PaginationMeta {
  readonly total?: number;
  readonly page?: number;
  readonly perPage?: number;
  readonly totalPages?: number;
}

/**
 * Out-of-band store for the counters, keyed by the unwrapped array itself.
 *
 * Why a side table rather than a property on the result or a wider return type:
 *
 * 1. The spec's Non-goals put pagination totals explicitly out of scope for
 *    P3's tool surface. A side table keeps `Promise<T>` meaning exactly what it
 *    meant before, so no caller and no test changes shape.
 * 2. The payload stays byte-identical to what v1 produces. Nothing is added to
 *    the array, not even a non-enumerable property, so `JSON.stringify`,
 *    deep-equality in tests and the formatters cannot tell the versions apart.
 *    That is version-blindness by construction rather than by convention.
 * 3. A later phase that does want totals adds a reader on top of this, which is
 *    additive: no breaking change to the return type it would otherwise have
 *    had to widen.
 * 4. A `WeakMap` needs no eviction. Entries die with the array they describe.
 *
 * The tradeoff, stated so a later phase is not surprised by it: metadata is
 * bound to array identity, so it does not survive `map`/`filter`/`slice`. A
 * consumer must read it at the boundary, which is where the spec puts
 * pagination handling anyway.
 */
const PAGINATION_META = new WeakMap<object, V2PaginationMeta>();

const SCHEMA_KEY = '$schema';

/**
 * Envelope keys that also act as the recognition signal. A body is treated as
 * an envelope only when it has an `items` array *and* at least one of these as
 * a number, so an ordinary entity that happens to carry an `items` array is
 * left alone. Verified against docs/vikunja-openapi-v2.json: of 136 component
 * schemas, the only ones with an `items` property are the 20 `Paginated*`
 * wrappers and `BucketsWithTasksBodyBody`, and every one of them has a numeric
 * `total`.
 */
const PAGINATION_KEYS = ['total', 'page', 'per_page', 'total_pages'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function readPaginationMeta(envelope: Record<string, unknown>): V2PaginationMeta {
  const total = readNumber(envelope.total);
  const page = readNumber(envelope.page);
  const perPage = readNumber(envelope.per_page);
  const totalPages = readNumber(envelope.total_pages);
  return {
    ...(total !== undefined ? { total } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(perPage !== undefined ? { perPage } : {}),
    ...(totalPages !== undefined ? { totalPages } : {}),
  };
}

function isEnvelope(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.items) && PAGINATION_KEYS.some((key) => typeof value[key] === 'number')
  );
}

/**
 * Converts a parsed v2 response body into the canonical internal shape:
 *
 * - a pagination envelope becomes its bare `items` array, with `total`,
 *   `page`, `per_page` and `total_pages` recorded out of band;
 * - any other object loses its top-level `$schema`;
 * - arrays, `null` and primitives pass through untouched.
 *
 * An envelope whose `items` is `null` rather than an array is deliberately not
 * special-cased. All three supported versions send `[]` for an empty page
 * (checked live on 2026-09-04), so handling a hypothetical `null` would be
 * untestable speculation; if some future version does send it, this returns the
 * envelope and the caller fails loudly instead of silently losing rows.
 */
export function normalizeV2Response<T = unknown>(body: unknown): T {
  if (!isPlainObject(body)) {
    return body as T;
  }

  if (isEnvelope(body)) {
    const items = body.items as unknown[];
    PAGINATION_META.set(items, readPaginationMeta(body));
    return items as T;
  }

  if (SCHEMA_KEY in body) {
    const stripped = { ...body };
    delete stripped.$schema;
    return stripped as T;
  }

  return body as T;
}

/**
 * Reads back the pagination counters recorded for a normalized v2 list result,
 * or `undefined` when the value did not come from a v2 envelope, which is the
 * normal case for a v1 response, a single entity, or a copy of a normalized
 * array.
 *
 * Nothing in P3 consumes this: it exists so the counters are not thrown away,
 * and so the phase that does surface them has somewhere to read them from.
 */
export function getV2PaginationMeta(value: unknown): V2PaginationMeta | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return PAGINATION_META.get(value);
}
