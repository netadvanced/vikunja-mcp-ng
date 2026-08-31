#!/usr/bin/env npx tsx
/**
 * Upstream watch CLI — fetches upstream Vikunja commits since the stored
 * watermark, filters them to what can plausibly affect this client, and emits a
 * structured digest (JSON) plus a readable markdown rendering.
 *
 * Tracking issue #250. All of the judgement — the path filter, the watermark
 * format, the bounding rules — lives in `scripts/lib/upstream-watch.ts` and is
 * unit-tested there. This file is deliberately thin: argv, `fetch`, files,
 * exit codes. No model, no secrets, no writes to the tracker (the workflow
 * posts; see .github/workflows/upstream-watch.yml).
 *
 * Usage:
 *
 *   # Local dry run — 14-day lookback, nothing stored, markdown to stdout:
 *   npm run watch:upstream -- --lookback-days 7
 *
 *   # What the workflow does:
 *   npm run watch:upstream -- --state-file issue-body.md \
 *     --json-out digest.json --md-out digest.md
 *
 *   # Second mode: rewrite an issue body with an advanced watermark.
 *   npm run watch:upstream -- --write-watermark \
 *     --state-file issue-body.md --watermark <sha> --watermark-date <iso> \
 *     --out issue-body.new.md
 *
 * EXIT CODES — the caller must be able to tell these apart:
 *   0  ran fine, nothing relevant  (post NOTHING)
 *   10 ran fine, findings to report
 *   1  the run failed              (watermark MUST NOT advance)
 *
 * Auth: none required. `GITHUB_TOKEN` (or `GH_TOKEN`) is used when present and
 * is strongly recommended — unauthenticated GitHub REST allows 60 requests an
 * hour and this makes one call per commit examined. The workflow passes the
 * default GITHUB_TOKEN, which needs no configuration.
 *
 * This never touches a local Vikunja clone. It reads public data over HTTPS.
 */

import fs from 'node:fs';
import {
  EXIT_CODES,
  MAX_COMMITS_PER_RUN,
  MAX_COMMIT_PAGES,
  UPSTREAM_BRANCH,
  UPSTREAM_REPO,
  applyWatermark,
  parseWatermark,
  renderDigestMarkdown,
  runUpstreamWatch,
  type UpstreamClient,
  type UpstreamCommitSummary,
  type UpstreamTag,
  type Watermark,
} from './lib/upstream-watch';

// ============================================================================
// Arguments
// ============================================================================

interface Options {
  repo: string;
  branch: string;
  stateFile: string | undefined;
  watermarkSha: string | undefined;
  watermarkDate: string | undefined;
  lookbackDays: number | undefined;
  maxCommits: number;
  jsonOut: string | undefined;
  mdOut: string | undefined;
  note: string | undefined;
  writeWatermark: boolean;
  out: string | undefined;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    repo: UPSTREAM_REPO,
    branch: UPSTREAM_BRANCH,
    stateFile: undefined,
    watermarkSha: undefined,
    watermarkDate: undefined,
    lookbackDays: undefined,
    maxCommits: MAX_COMMITS_PER_RUN,
    jsonOut: undefined,
    mdOut: undefined,
    note: undefined,
    writeWatermark: false,
    out: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${String(arg)} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--repo':
        options.repo = next();
        break;
      case '--branch':
        options.branch = next();
        break;
      case '--state-file':
        options.stateFile = next();
        break;
      case '--watermark':
        options.watermarkSha = next();
        break;
      case '--watermark-date':
        options.watermarkDate = next();
        break;
      case '--lookback-days':
        options.lookbackDays = Number.parseInt(next(), 10);
        break;
      case '--max-commits':
        options.maxCommits = Number.parseInt(next(), 10);
        break;
      case '--json-out':
        options.jsonOut = next();
        break;
      case '--md-out':
        options.mdOut = next();
        break;
      case '--note':
        options.note = next();
        break;
      case '--write-watermark':
        options.writeWatermark = true;
        break;
      case '--out':
        options.out = next();
        break;
      default:
        throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  return options;
}

// ============================================================================
// GitHub REST client
// ============================================================================

interface CommitListEntry {
  sha?: string;
  html_url?: string;
  commit?: {
    message?: string;
    committer?: { date?: string };
    author?: { name?: string; date?: string };
  };
}

interface CommitDetail {
  files?: { filename?: string }[];
}

interface TagEntry {
  name?: string;
  commit?: { sha?: string };
}

class GitHubUpstreamClient implements UpstreamClient {
  private readonly headers: Record<string, string>;

  constructor(
    private readonly repo: string,
    private readonly branch: string,
    token: string | undefined,
  ) {
    this.headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vikunja-mcp-ng-upstream-watch',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  private async get<T>(path: string): Promise<T> {
    const url = `https://api.github.com${path}`;
    // Two retries on transient upstream failures. A hard failure here must
    // surface as EXIT_CODES.FAILURE so the watermark stays put and the window
    // is re-examined next week — never swallowed into a false "nothing found".
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(url, { headers: this.headers });
      if (response.ok) return (await response.json()) as T;
      const body = (await response.text()).slice(0, 300);
      lastError = new Error(`GET ${path} -> ${String(response.status)} ${body}`);
      const retryable = response.status >= 500 || response.status === 429;
      if (!retryable) break;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
    throw lastError ?? new Error(`GET ${path} failed`);
  }

  async listCommits(sinceIso: string): Promise<UpstreamCommitSummary[]> {
    const commits: UpstreamCommitSummary[] = [];
    for (let page = 1; page <= MAX_COMMIT_PAGES; page += 1) {
      const query = new URLSearchParams({
        sha: this.branch,
        since: sinceIso,
        per_page: '100',
        page: String(page),
      });
      const batch = await this.get<CommitListEntry[]>(
        `/repos/${this.repo}/commits?${query.toString()}`,
      );
      for (const entry of batch) {
        if (!entry.sha) continue;
        commits.push({
          sha: entry.sha,
          date: entry.commit?.committer?.date ?? entry.commit?.author?.date ?? sinceIso,
          message: entry.commit?.message ?? '',
          author: entry.commit?.author?.name ?? 'unknown',
          url: entry.html_url ?? `https://github.com/${this.repo}/commit/${entry.sha}`,
        });
      }
      if (batch.length < 100) return commits;
    }
    // Page ceiling hit: report it loudly rather than pretending the window ended.
    console.warn(
      `[upstream-watch] page ceiling (${String(MAX_COMMIT_PAGES)}) reached; ` +
        'the oldest part of this window was not listed and will be re-examined next run.',
    );
    return commits;
  }

  async listCommitFiles(sha: string): Promise<string[]> {
    const detail = await this.get<CommitDetail>(`/repos/${this.repo}/commits/${sha}`);
    return (detail.files ?? [])
      .map((file) => file.filename)
      .filter((name): name is string => typeof name === 'string');
  }

  async listTags(): Promise<UpstreamTag[]> {
    const tags = await this.get<TagEntry[]>(`/repos/${this.repo}/tags?per_page=30`);
    return tags
      .filter((tag): tag is { name: string; commit: { sha: string } } =>
        Boolean(tag.name && tag.commit?.sha),
      )
      .map((tag) => ({ name: tag.name, sha: tag.commit.sha }));
  }
}

// ============================================================================
// Helpers
// ============================================================================

function readStateFile(path: string | undefined): string {
  if (!path) return '';
  if (!fs.existsSync(path)) return '';
  return fs.readFileSync(path, 'utf8');
}

function resolveWatermark(options: Options): Watermark | null {
  if (options.watermarkSha && options.watermarkDate) {
    return { sha: options.watermarkSha.toLowerCase(), date: options.watermarkDate };
  }
  return parseWatermark(readStateFile(options.stateFile));
}

/** Emits step outputs when running under Actions; a no-op anywhere else. */
function writeGithubOutput(values: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
}

// ============================================================================
// Modes
// ============================================================================

function writeWatermarkMode(options: Options): number {
  if (!options.stateFile || !options.out) {
    console.error('--write-watermark requires --state-file and --out');
    return EXIT_CODES.FAILURE;
  }
  if (!options.watermarkSha || !options.watermarkDate) {
    console.error('--write-watermark requires --watermark and --watermark-date');
    return EXIT_CODES.FAILURE;
  }
  const body = readStateFile(options.stateFile);
  const updated = applyWatermark(body, {
    sha: options.watermarkSha.toLowerCase(),
    date: options.watermarkDate,
  });
  fs.writeFileSync(options.out, updated);
  console.error(`[upstream-watch] watermark -> ${options.watermarkSha.slice(0, 8)}`);
  return EXIT_CODES.EMPTY;
}

async function watchMode(options: Options): Promise<number> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    console.warn(
      '[upstream-watch] no GITHUB_TOKEN/GH_TOKEN — falling back to unauthenticated GitHub REST (60 req/h).',
    );
  }
  const client = new GitHubUpstreamClient(options.repo, options.branch, token);
  const watermark = resolveWatermark(options);

  const digest = await runUpstreamWatch(client, {
    watermark,
    now: new Date(),
    maxCommits: options.maxCommits,
    repo: options.repo,
    branch: options.branch,
    ...(options.lookbackDays === undefined ? {} : { lookbackDays: options.lookbackDays }),
  });

  const markdown = renderDigestMarkdown(digest, options.note);
  if (options.jsonOut) fs.writeFileSync(options.jsonOut, `${JSON.stringify(digest, null, 2)}\n`);
  if (options.mdOut) fs.writeFileSync(options.mdOut, markdown);
  if (!options.mdOut && digest.status === 'findings') process.stdout.write(markdown);

  writeGithubOutput({
    status: digest.status,
    count: String(digest.findings.length),
    scanned: String(digest.scanned),
    truncated: String(digest.truncated),
    next_watermark_sha: digest.nextWatermark?.sha ?? '',
    next_watermark_date: digest.nextWatermark?.date ?? '',
  });

  console.error(
    `[upstream-watch] ${options.repo}@${options.branch}: ` +
      `${String(digest.scanned)} commit(s) examined, ${String(digest.findings.length)} relevant` +
      (digest.truncated ? `, ${String(digest.deferred)} deferred to the next run` : '') +
      ` (${digest.window.reason})`,
  );

  return digest.status === 'findings' ? EXIT_CODES.FINDINGS : EXIT_CODES.EMPTY;
}

// ============================================================================
// Entry point
// ============================================================================

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.writeWatermark) return writeWatermarkMode(options);
  return watchMode(options);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // A failed run is NOT an empty run. Exiting 1 here is what keeps the
    // caller from advancing the watermark past an unexamined window.
    console.error(
      `[upstream-watch] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = EXIT_CODES.FAILURE;
  });
