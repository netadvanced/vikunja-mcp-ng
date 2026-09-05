/**
 * Upstream watch — the deterministic half (tracking issue #250).
 *
 * WHY THIS EXISTS
 *
 * Vikunja 2.6.0 shipped 17 breaking changes for a client doing what we do,
 * while the v1 OpenAPI surface moved by exactly ONE operation (169 -> 170).
 * Almost all of it was handler-level enforcement the spec does not describe:
 * token-scope checks on `expand`, a nullable `max_permission`, view-ownership
 * checks on task positioning, archived-project write refusals. Two consequences
 * drive everything below:
 *
 *   1. Waiting for release tags is archaeology. By the time a tag lands the
 *      changes arrive as an undifferentiated pile. Watching upstream `main`
 *      shows each change next to the commit that explains it.
 *   2. Diffing `swagger.json` finds almost nothing. The signal lives in
 *      `pkg/models/**`, `pkg/routes/**`, permission files, migrations and
 *      security fixes. `pkg/swagger/**` is EXCLUDED here on purpose — it is
 *      the trap this whole thing exists to avoid.
 *
 * WHAT LIVES HERE vs. IN THE CLI
 *
 * This module is pure: no network, no filesystem, no `process`, no
 * `import.meta`. Everything that can be wrong about the filter, the watermark
 * or the bounding rules is decided here, and is unit-tested from
 * `tests/upstream-watch.test.ts` against fixtured upstream responses.
 * `scripts/upstream-watch.ts` is the thin CLI: argv, `fetch`, files, exit codes.
 *
 * NO MODEL IS INVOLVED IN THIS HALF. It cannot invent a commit.
 */

// ============================================================================
// Upstream identity
// ============================================================================

/** The repository watched. Read-only, public; never the owner's local clone. */
export const UPSTREAM_REPO = 'go-vikunja/vikunja';

/** Watched ref. `main`, deliberately — see "WHY THIS EXISTS" above. */
export const UPSTREAM_BRANCH = 'main';

// ============================================================================
// The filter — ONE place to tune what counts as relevant
// ============================================================================

/**
 * A path rule. `match` is one of three forms, checked in this order:
 *   - ends with `/`  -> directory prefix   (`pkg/models/`)
 *   - starts with `*` -> filename suffix   (`*_permissions.go`, any directory)
 *   - otherwise       -> exact path        (`go.mod`)
 * `why` is not decoration: it is what a reader needs in order to decide
 * whether a future tuning of this list is safe.
 */
export interface PathRule {
  readonly match: string;
  readonly why: string;
}

/**
 * Paths whose change can plausibly change what our client observes.
 *
 * Tune HERE and nowhere else. Adding a rule is cheap (more digest noise);
 * removing one is what makes a 2.6.0-shaped surprise possible again.
 */
export const RELEVANT_UPSTREAM_PATHS: readonly PathRule[] = [
  {
    match: 'pkg/models/',
    why: 'Entity shapes, validation, and the CanRead/CanUpdate/CanDelete rights methods — where 2.6.0 put most of its handler-level enforcement.',
  },
  {
    match: 'pkg/routes/',
    why: 'Route wiring, middleware, token-scope enforcement, rate limits, error shaping — endpoint behaviour the spec never describes.',
  },
  {
    match: 'pkg/web/',
    why: 'The generic CRUD handler layer that dispatches every rights check. A change here changes every endpoint at once.',
  },
  {
    match: 'pkg/migration/',
    why: 'Schema and data migrations: field semantics, defaults and backfills change under a client that never sees the migration.',
  },
  {
    match: 'pkg/modules/auth/',
    why: 'API tokens, token scopes, OIDC, link shares — how we authenticate and what our token is allowed to reach.',
  },
  {
    match: 'pkg/modules/humabridge/',
    why: 'The v2 API surface bridge. v2 adoption is tracked in #184; changes here move that target.',
  },
  {
    match: 'pkg/user/',
    why: 'User endpoints and token handling — the JWT-only surface our auth mode switches on.',
  },
  {
    match: '*_permissions.go',
    why: 'Permission files by name, wherever they move to. Renames and relocations must not fall out of the window.',
  },
  {
    match: '*_rights.go',
    why: 'Same, for the older `rights` naming upstream still carries in places.',
  },
];

/**
 * Checked BEFORE the relevant list. A path matching here can never make a
 * commit relevant on its own — but it does not veto a commit that also
 * touches a watched path.
 */
export const IRRELEVANT_UPSTREAM_PATHS: readonly PathRule[] = [
  {
    match: 'pkg/swagger/',
    why: 'THE TRAP. The generated spec moved by one operation across 17 breaking changes; it is evidence of nothing.',
  },
  {
    match: '*swagger.json',
    why: 'Same, wherever the artefact is checked in.',
  },
  {
    match: '*_test.go',
    why: 'A test-only change does not change the API a client sees; behaviour changes always ship with their source. Keeps the renovate/CI churn out of the digest.',
  },
  {
    match: 'frontend/',
    why: 'The web UI is not our client surface. Renovate churns it several times a day.',
  },
  {
    match: 'docs/',
    why: 'Prose. Read it when a finding points at it, not weekly.',
  },
  {
    match: '.github/',
    why: 'Their CI, not their API.',
  },
  {
    match: 'pkg/i18n/',
    why: 'Translation catalogues.',
  },
];

/**
 * A commit whose message trips this is relevant regardless of which files it
 * touched. Security fixes are exactly the class that lands as a one-line
 * change in a file nobody thought to watch — and the class we least want to
 * learn about from a release note.
 */
export const SECURITY_SIGNAL_PATTERN =
  /\b(?:security|vulnerabilit(?:y|ies)|CVE-\d{4}-\d{4,}|XSS|CSRF|SSRF|SQL injection|auth(?:entication|orization)? bypass|privilege escalation|IDOR|leak(?:s|ed|ing)? (?:data|token|secret))\b/i;

/**
 * How much of a commit body the security scan reads.
 *
 * Observed on a real run (2026-08-28..31): renovate commits paste the whole
 * upstream changelog into the body, and `fix(deps): update dependency axios`
 * tripped the pattern on a CVE note quoted a hundred lines down — a finding
 * about axios's release notes, not about Vikunja. A change that is a security
 * fix says so in its subject or its opening paragraph; anything further down is
 * quoted material. This bound is the difference between a usable signal and
 * renovate noise every week.
 */
export const SECURITY_SCAN_BODY_CHARS = 400;

// ============================================================================
// Bounding — a run must never be unbounded, and must never lose a window
// ============================================================================

/**
 * First run with no watermark: look back this far and no further. Dumping the
 * entire upstream history into the tracker would bury the thing it exists to
 * surface.
 */
export const DEFAULT_FIRST_RUN_LOOKBACK_DAYS = 14;

/**
 * Hard cap on commits examined in one run. When a window is bigger, the
 * OLDEST `MAX_COMMITS_PER_RUN` are processed and the watermark advances to the
 * newest of THOSE — so the remainder is picked up by the next run instead of
 * being skipped. Processing the newest N and advancing past the rest is the
 * silent-gap failure mode; do not "simplify" it back.
 */
export const MAX_COMMITS_PER_RUN = 300;

/** Page-fetch ceiling for the commit listing, so a pathological window cannot run away. */
export const MAX_COMMIT_PAGES = 10;

// ============================================================================
// Types
// ============================================================================

/** One upstream commit as the listing endpoint returns it (no files yet). */
export interface UpstreamCommitSummary {
  sha: string;
  /** Committer date, ISO 8601. Used for the `since` window; author dates are not monotonic. */
  date: string;
  /** Full commit message, first line included. */
  message: string;
  author: string;
  url: string;
}

/** A commit with its file list resolved. */
export interface UpstreamCommit extends UpstreamCommitSummary {
  files: readonly string[];
}

/** A tag seen upstream. */
export interface UpstreamTag {
  name: string;
  sha: string;
}

/** A commit that survived the filter, with the reason it did. */
export interface Finding {
  sha: string;
  shortSha: string;
  date: string;
  /** First line of the commit message. */
  subject: string;
  author: string;
  url: string;
  /** Watched paths this commit touched. May be empty for a message-only security match. */
  paths: string[];
  /** True when SECURITY_SIGNAL_PATTERN matched the message. */
  securitySignal: boolean;
}

/** The stored point in upstream history that has already been triaged. */
export interface Watermark {
  sha: string;
  /** Committer date of `sha`, ISO 8601 — the `since` bound for the next run. */
  date: string;
}

/** How this run's window was derived. */
export interface WatchWindow {
  sinceIso: string;
  mode: 'watermark' | 'first-run';
  /** The watermark commit, excluded from its own window. Null on a first run. */
  watermarkSha: string | null;
  /** Human-readable reason, rendered into the digest so a surprising window explains itself. */
  reason: string;
}

/** The structured digest. This is the artefact; the markdown is a rendering of it. */
export interface WatchDigest {
  generatedAt: string;
  repo: string;
  branch: string;
  window: WatchWindow;
  /** Commits examined (after bounding), relevant or not. */
  scanned: number;
  /** Commits left in the window for the next run because of MAX_COMMITS_PER_RUN. */
  deferred: number;
  truncated: boolean;
  findings: Finding[];
  /** Tags whose target commit falls inside this window. */
  tags: UpstreamTag[];
  /**
   * `empty` = ran fine, nothing relevant (post NOTHING).
   * `findings` = ran fine, N relevant commits.
   */
  status: 'empty' | 'findings';
  /**
   * Where the watermark should move to — the newest commit EXAMINED, relevant
   * or not, so irrelevant commits are not rescanned every week. Null when the
   * window held no commits at all, in which case the caller keeps what it has.
   */
  nextWatermark: Watermark | null;
}

/** Process exit codes. The caller must be able to tell these three apart. */
export const EXIT_CODES = {
  /** Ran fine, nothing relevant. */
  EMPTY: 0,
  /** The run itself failed. Watermark MUST NOT advance. */
  FAILURE: 1,
  /** Ran fine, findings to report. */
  FINDINGS: 10,
} as const;

// ============================================================================
// The filter, applied
// ============================================================================

function matchesRule(filePath: string, rule: PathRule): boolean {
  const { match } = rule;
  if (match.endsWith('/')) return filePath.startsWith(match);
  if (match.startsWith('*')) return filePath.endsWith(match.slice(1));
  return filePath === match;
}

/** True when this single path is one we watch (and not one we explicitly ignore). */
export function isRelevantPath(filePath: string): boolean {
  if (IRRELEVANT_UPSTREAM_PATHS.some((rule) => matchesRule(filePath, rule))) return false;
  return RELEVANT_UPSTREAM_PATHS.some((rule) => matchesRule(filePath, rule));
}

/** The watched paths a commit touched, in the order the API listed them. */
export function relevantPathsIn(files: readonly string[]): string[] {
  return files.filter((file) => isRelevantPath(file));
}

/**
 * True when the commit message itself is enough to make the commit relevant.
 * Only the subject and the opening of the body are read — see
 * SECURITY_SCAN_BODY_CHARS for the renovate-noise reason.
 */
export function hasSecuritySignal(message: string): boolean {
  const newline = message.indexOf('\n');
  const subject = newline === -1 ? message : message.slice(0, newline);
  const body =
    newline === -1 ? '' : message.slice(newline + 1, newline + 1 + SECURITY_SCAN_BODY_CHARS);
  return SECURITY_SIGNAL_PATTERN.test(subject) || SECURITY_SIGNAL_PATTERN.test(body);
}

/** Triages one commit. Returns null when nothing about it concerns us. */
export function triageCommit(commit: UpstreamCommit): Finding | null {
  const paths = relevantPathsIn(commit.files);
  const securitySignal = hasSecuritySignal(commit.message);
  if (paths.length === 0 && !securitySignal) return null;
  return {
    sha: commit.sha,
    shortSha: commit.sha.slice(0, 8),
    date: commit.date,
    subject: commit.message.split('\n')[0] ?? '',
    author: commit.author,
    url: commit.url,
    paths,
    securitySignal,
  };
}

// ============================================================================
// Watermark storage — an HTML marker inside the tracking issue's body
// ============================================================================

/**
 * The machine-readable half of the watermark line in issue #250's body.
 *
 * WHY THE ISSUE BODY, and not a committed file or an Actions cache:
 *   - Actions cache entries are evicted after 7 days without a read. The cadence
 *     here is weekly — the watermark would sit exactly on the eviction boundary
 *     and would sometimes vanish, silently re-running a lookback or skipping.
 *     That is the invisible failure this design refuses.
 *   - A committed file means the job pushes to `main`, which this repo forbids
 *     (feature branches only), and adds a commit a week to a release history.
 *   - The issue body is written with the same `issues: write` permission the job
 *     already needs, is human-readable and hand-correctable in the browser, and
 *     lives next to the output it explains.
 *
 * The ordering rule that makes it safe: the body is only updated AFTER the
 * digest has been posted. If the post fails, the watermark stays put and the
 * next run re-examines the same window. Worst case is a duplicate section;
 * losing a week silently is not on the table.
 */
export const WATERMARK_MARKER_PREFIX = 'upstream-watch:watermark';

const WATERMARK_LINE_RE = new RegExp(
  `<!--\\s*${WATERMARK_MARKER_PREFIX}\\s+sha=([0-9a-fA-F]{7,40})\\s+date=([^\\s>]+)\\s*-->`,
);

/**
 * Reads the watermark out of an issue body. Returns null when absent or
 * malformed — both of which mean "first run", i.e. bounded lookback, never
 * "whole history".
 */
export function parseWatermark(issueBody: string): Watermark | null {
  const lines = issueBody.split('\n');
  // Last match wins: appended corrections land below stale text.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = WATERMARK_LINE_RE.exec(lines[i] ?? '');
    if (!match) continue;
    const sha = match[1];
    const date = match[2];
    if (!sha || !date) return null;
    if (Number.isNaN(Date.parse(date))) return null;
    return { sha: sha.toLowerCase(), date };
  }
  return null;
}

/** Renders the single line that carries the watermark, human half included. */
export function renderWatermarkLine(watermark: Watermark): string {
  return (
    `Watermark: \`${watermark.sha.slice(0, 8)}\` at \`${watermark.date}\` ` +
    `(updated by .github/workflows/upstream-watch.yml) ` +
    `<!-- ${WATERMARK_MARKER_PREFIX} sha=${watermark.sha} date=${watermark.date} -->`
  );
}

/**
 * Returns the issue body with the watermark set to `watermark`, replacing the
 * existing marker line in place when there is one and appending it otherwise.
 * Every other byte of the body is left alone — the issue is written by humans.
 */
export function applyWatermark(issueBody: string, watermark: Watermark): string {
  const lines = issueBody.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (WATERMARK_LINE_RE.test(lines[i] ?? '')) {
      lines[i] = renderWatermarkLine(watermark);
      return lines.join('\n');
    }
  }
  const trimmed = issueBody.replace(/\s+$/, '');
  return `${trimmed}\n\n${renderWatermarkLine(watermark)}\n`;
}

// ============================================================================
// Window resolution and bounding
// ============================================================================

/**
 * Decides the `since` bound for this run.
 *
 * With a watermark: its own commit date, and its sha is dropped from the
 * result (GitHub's `since` is inclusive). Without one: a bounded lookback.
 */
export function resolveWindow(options: {
  watermark: Watermark | null;
  now: Date;
  lookbackDays?: number;
}): WatchWindow {
  const { watermark, now } = options;
  const lookbackDays = options.lookbackDays ?? DEFAULT_FIRST_RUN_LOOKBACK_DAYS;
  if (watermark) {
    return {
      sinceIso: watermark.date,
      mode: 'watermark',
      watermarkSha: watermark.sha,
      reason: `since the last triaged commit ${watermark.sha.slice(0, 8)}`,
    };
  }
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  return {
    sinceIso: since.toISOString(),
    mode: 'first-run',
    watermarkSha: null,
    reason: `no watermark stored — bounded to the last ${lookbackDays} days`,
  };
}

/**
 * Applies MAX_COMMITS_PER_RUN to an OLDEST-FIRST commit list.
 *
 * The oldest slice is processed so the watermark can advance to a point with
 * nothing untriaged behind it; the rest is explicitly deferred to the next run.
 */
export function boundCommits<T>(
  commits: readonly T[],
  maxCommits: number = MAX_COMMITS_PER_RUN,
): { processed: T[]; deferred: number; truncated: boolean } {
  if (commits.length <= maxCommits) {
    return { processed: [...commits], deferred: 0, truncated: false };
  }
  return {
    processed: commits.slice(0, maxCommits),
    deferred: commits.length - maxCommits,
    truncated: true,
  };
}

// ============================================================================
// Digest assembly and rendering
// ============================================================================

/** Assembles the digest from already-fetched, already-bounded commits (oldest first). */
export function buildDigest(input: {
  commits: readonly UpstreamCommit[];
  tags: readonly UpstreamTag[];
  window: WatchWindow;
  deferred: number;
  truncated: boolean;
  generatedAt: Date;
  repo?: string;
  branch?: string;
}): WatchDigest {
  const findings: Finding[] = [];
  for (const commit of input.commits) {
    const finding = triageCommit(commit);
    if (finding) findings.push(finding);
  }
  const shas = new Set(input.commits.map((commit) => commit.sha));
  const tags = input.tags.filter((tag) => shas.has(tag.sha));
  const newest = input.commits[input.commits.length - 1];
  return {
    generatedAt: input.generatedAt.toISOString(),
    repo: input.repo ?? UPSTREAM_REPO,
    branch: input.branch ?? UPSTREAM_BRANCH,
    window: input.window,
    scanned: input.commits.length,
    deferred: input.deferred,
    truncated: input.truncated,
    findings,
    tags,
    status: findings.length > 0 ? 'findings' : 'empty',
    nextWatermark: newest ? { sha: newest.sha, date: newest.date } : null,
  };
}

function commitUrl(repo: string, sha: string): string {
  return `https://github.com/${repo}/commit/${sha}`;
}

/**
 * Renders the dated section appended to the tracking issue.
 *
 * Callers must NOT post this when `status === 'empty'` — a tracker that says
 * "nothing to report" every week gets muted, and then it is worse than nothing.
 * `note` is where the workflow states whether agent triage ran or was skipped.
 */
export function renderDigestMarkdown(digest: WatchDigest, note?: string): string {
  const day = digest.generatedAt.slice(0, 10);
  const count = digest.findings.length;
  const out: string[] = [];

  out.push(`## ${day} — ${count} relevant commit${count === 1 ? '' : 's'}`);
  out.push('');
  out.push(
    `\`${digest.repo}@${digest.branch}\` · ${digest.scanned} commit${digest.scanned === 1 ? '' : 's'} examined · ` +
      `window: ${digest.window.reason} (since \`${digest.window.sinceIso}\`)`,
  );
  if (digest.truncated) {
    out.push('');
    out.push(
      `> Window capped at ${MAX_COMMITS_PER_RUN} commits. ${digest.deferred} older commit${digest.deferred === 1 ? '' : 's'} ` +
        'remain untriaged and will be picked up by the next run — the watermark advanced only to the newest commit examined here.',
    );
  }
  out.push('');

  for (const finding of digest.findings) {
    const marker = finding.securitySignal ? '**[security signal]** ' : '';
    out.push(`### ${marker}${finding.subject}`);
    out.push('');
    out.push(
      `[\`${finding.shortSha}\`](${commitUrl(digest.repo, finding.sha)}) · ${finding.date} · ${finding.author}`,
    );
    out.push('');
    if (finding.paths.length > 0) {
      for (const path of finding.paths) out.push(`- \`${path}\``);
    } else {
      out.push('- no watched paths touched — flagged by its commit message alone');
    }
    out.push('');
  }

  if (digest.tags.length > 0) {
    out.push('### Tags in this window');
    out.push('');
    for (const tag of digest.tags) {
      out.push(
        `- \`${tag.name}\` — [\`${tag.sha.slice(0, 8)}\`](${commitUrl(digest.repo, tag.sha)})`,
      );
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(
    `_Candidates, not commitments._ Filter: \`scripts/lib/upstream-watch.ts\` (${RELEVANT_UPSTREAM_PATHS.length} watched path rules; ` +
      '`pkg/swagger/**` deliberately excluded).',
  );
  if (note) {
    out.push('');
    out.push(`_${note}_`);
  }
  return `${out.join('\n')}\n`;
}

// ============================================================================
// The run — network injected, so this is testable with fixtures
// ============================================================================

/** Everything the run needs from upstream. Implemented over `fetch` by the CLI. */
export interface UpstreamClient {
  /** Commits on the watched branch since `sinceIso`, NEWEST FIRST (as GitHub returns them). */
  listCommits(sinceIso: string): Promise<UpstreamCommitSummary[]>;
  /** File paths touched by one commit. */
  listCommitFiles(sha: string): Promise<string[]>;
  /** Recent tags. Filtered down to this window's commits by `buildDigest`. */
  listTags(): Promise<UpstreamTag[]>;
}

/**
 * Runs one watch pass. Throws on transport failure — the caller turns that into
 * EXIT_CODES.FAILURE and, critically, does NOT advance the watermark.
 */
export async function runUpstreamWatch(
  client: UpstreamClient,
  options: {
    watermark: Watermark | null;
    now: Date;
    lookbackDays?: number;
    maxCommits?: number;
    repo?: string;
    branch?: string;
  },
): Promise<WatchDigest> {
  const window = resolveWindow({
    watermark: options.watermark,
    now: options.now,
    ...(options.lookbackDays === undefined ? {} : { lookbackDays: options.lookbackDays }),
  });

  const newestFirst = await client.listCommits(window.sinceIso);
  // `since` is inclusive, so the watermark commit comes back in its own window.
  const oldestFirst = [...newestFirst]
    .reverse()
    .filter((commit) => commit.sha !== window.watermarkSha);

  const { processed, deferred, truncated } = boundCommits(
    oldestFirst,
    options.maxCommits ?? MAX_COMMITS_PER_RUN,
  );

  const withFiles: UpstreamCommit[] = [];
  for (const commit of processed) {
    withFiles.push({ ...commit, files: await client.listCommitFiles(commit.sha) });
  }

  const tags = processed.length > 0 ? await client.listTags() : [];

  return buildDigest({
    commits: withFiles,
    tags,
    window,
    deferred,
    truncated,
    generatedAt: options.now,
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
  });
}
