/**
 * The one field neither project-update strategy may hand back.
 *
 * `max_permission` is a P3 non-goal: the spec's non-goals put it explicitly
 * out of the tool surface for this milestone. Unlike the task, team and saved
 * filter pairs, where the field is a v2 addition and stripping it on the v2
 * side is enough, here BOTH paths return it and they do not agree on the
 * value. Probed live on 2026-09-06, one owned project per version:
 *
 *   | version | v1 `GET` | v1 `POST` (v1 strategy result) | v2 `GET` | v2 `PATCH` (v2 strategy result) |
 *   |---------|----------|--------------------------------|----------|---------------------------------|
 *   | 2.4.0   | `0`      | `0`                            | `2`      | `null`                          |
 *   | 2.5.0   | `0`      | `0`                            | `2`      | `null`                          |
 *   | 2.6.0   | `null`   | `null`                         | `2`      | `null`                          |
 *
 * So on 2.4.0 and 2.5.0 the same logical update renders `0` through v1 and
 * `null` through v2, which is a caller-visible tell of which strategy ran and
 * the exact thing this epic promised not to produce. There is a second
 * divergence inside the v2 strategy alone: its `304` no-op path re-reads over
 * v1 and therefore yields `0` where a real patch yielded `null`.
 *
 * Stripping only the v2 side would trade a `0`-vs-`null` divergence for an
 * absent-vs-`0` one, which is no better. Stripping on both is what makes the
 * two paths genuinely identical, and it is what the spec asked for in the
 * first place. It does remove a key the v1 path emits today, and that is a
 * deliberate, argued call rather than an oversight: the value is documented
 * garbage (`docs/VIKUNJA_API_ISSUES.md` #23: `0` where the spec promises a
 * permission level, `null` from 2.6.0 on), nothing in `src/` reads it, and
 * the spec says it should not be on the tool surface.
 *
 * (`$schema`, the only other key v2 adds, is already dropped by the v2
 * transport's response normalizer before a strategy sees it.)
 */

import type { VikunjaProject } from './types';

/**
 * Returns the project a caller is owed: the server's answer minus the fields
 * P3 keeps off the tool surface. Applied by both strategies, on every path
 * that produces a result, including the v2 `304` fallback read.
 */
export function toCanonicalProject(project: VikunjaProject): VikunjaProject {
  const canonical: VikunjaProject = { ...project };
  delete canonical.max_permission;
  return canonical;
}
