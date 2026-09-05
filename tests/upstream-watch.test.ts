/**
 * Tests for the deterministic half of the upstream watch (issue #250).
 *
 * Everything here is fixtured — no network. `UpstreamClient` is an interface
 * precisely so the run can be exercised against canned GitHub responses; a
 * test that hit api.github.com would be a flaky test that also rate-limits CI.
 *
 * The four rules worth breaking a build over:
 *   1. the filter includes what matters and excludes the swagger trap,
 *   2. the watermark advances ONLY past commits that were actually examined,
 *   3. a first run is bounded and never dumps history,
 *   4. an empty result is distinguishable from a failure.
 */

import {
  EXIT_CODES,
  MAX_COMMITS_PER_RUN,
  applyWatermark,
  boundCommits,
  buildDigest,
  hasSecuritySignal,
  isRelevantPath,
  parseWatermark,
  relevantPathsIn,
  renderDigestMarkdown,
  renderWatermarkLine,
  resolveWindow,
  runUpstreamWatch,
  triageCommit,
  type UpstreamClient,
  type UpstreamCommit,
  type UpstreamCommitSummary,
  type UpstreamTag,
} from '../scripts/lib/upstream-watch';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function commit(overrides: Partial<UpstreamCommit> & { sha: string }): UpstreamCommit {
  return {
    date: '2026-08-30T12:00:00Z',
    message: 'chore: something',
    author: 'upstream dev',
    url: `https://github.com/go-vikunja/vikunja/commit/${overrides.sha}`,
    files: [],
    ...overrides,
  };
}

/**
 * A fixtured upstream. `files` maps sha -> paths; `commits` is NEWEST FIRST,
 * exactly as GitHub's list endpoint returns it.
 */
class FakeUpstream implements UpstreamClient {
  public listCommitsCalls: string[] = [];
  public fileCalls: string[] = [];

  constructor(
    private readonly commits: UpstreamCommitSummary[],
    private readonly files: Record<string, string[]> = {},
    private readonly tags: UpstreamTag[] = [],
  ) {}

  listCommits(sinceIso: string): Promise<UpstreamCommitSummary[]> {
    this.listCommitsCalls.push(sinceIso);
    return Promise.resolve(this.commits);
  }

  listCommitFiles(sha: string): Promise<string[]> {
    this.fileCalls.push(sha);
    return Promise.resolve(this.files[sha] ?? []);
  }

  listTags(): Promise<UpstreamTag[]> {
    return Promise.resolve(this.tags);
  }
}

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

describe('isRelevantPath', () => {
  it.each([
    ['pkg/models/tasks.go', 'entity shapes and rights methods'],
    ['pkg/models/task_position.go', 'the 2.6.0 view-ownership class of change'],
    ['pkg/routes/rate_limit.go', 'endpoint behaviour the spec never describes'],
    ['pkg/routes/api/v1/handler.go', 'nested route wiring'],
    ['pkg/web/handler/create.go', 'the generic CRUD/rights dispatch layer'],
    ['pkg/migration/20260101.go', 'field semantics changing under us'],
    ['pkg/modules/auth/openid/openid.go', 'how we authenticate'],
    ['pkg/modules/humabridge/bridge.go', 'the v2 surface (#184)'],
    ['pkg/user/user.go', 'the JWT-only surface'],
  ])('includes %s (%s)', (path) => {
    expect(isRelevantPath(path)).toBe(true);
  });

  it('includes a permission file wherever it lives, by filename', () => {
    expect(isRelevantPath('pkg/somewhere/new/tasks_permissions.go')).toBe(true);
    expect(isRelevantPath('internal/legacy_rights.go')).toBe(true);
  });

  it.each([
    [
      'pkg/swagger/docs.go',
      'THE TRAP — the spec moved by one operation across 17 breaking changes',
    ],
    ['pkg/swagger/swagger.json', 'same artefact, same trap'],
    ['frontend/src/views/Task.vue', 'not our client surface'],
    ['docs/content/blog/post.md', 'prose'],
    ['.github/workflows/ci.yml', 'their CI, not their API'],
    ['pkg/i18n/lang/en.json', 'translation catalogues'],
    ['go.mod', 'not a watched path'],
    ['Makefile', 'not a watched path'],
  ])('excludes %s (%s)', (path) => {
    expect(isRelevantPath(path)).toBe(false);
  });

  it('excludes test files even under a watched directory', () => {
    // A test-only change does not change the API a client sees, and upstream
    // churns these constantly.
    expect(isRelevantPath('pkg/models/tasks_test.go')).toBe(false);
    expect(isRelevantPath('pkg/models/tasks.go')).toBe(true);
  });

  it('lets exclusions win over inclusions for the same path', () => {
    // `pkg/models/permissions_test.go` matches TWO include rules and one
    // exclude rule; the exclude must win.
    expect(isRelevantPath('pkg/models/permissions_test.go')).toBe(false);
  });

  it('keeps a commit relevant when it touches a watched path alongside excluded ones', () => {
    expect(
      relevantPathsIn(['pkg/swagger/docs.go', 'frontend/x.vue', 'pkg/models/tasks.go']),
    ).toEqual(['pkg/models/tasks.go']);
  });

  it('returns no paths for a wholly irrelevant commit', () => {
    expect(relevantPathsIn(['pkg/swagger/docs.go', 'frontend/x.vue'])).toEqual([]);
  });
});

describe('hasSecuritySignal', () => {
  it.each([
    'fix: security issue in link shares',
    'fix(api): CVE-2026-12345 in attachment handling',
    'fix: authorization bypass on project views',
    'fix: privilege escalation for team members',
    'fix: prevent XSS in task descriptions',
  ])('flags %s', (message) => {
    expect(hasSecuritySignal(message)).toBe(true);
  });

  it.each(['chore(deps): update dependency vue', 'feat(frontend): configure v2 client runtime'])(
    'does not flag %s',
    (message) => {
      expect(hasSecuritySignal(message)).toBe(false);
    },
  );

  it('reads the opening of the body, where a real fix explains itself', () => {
    expect(
      hasSecuritySignal('fix(models): tighten link share checks\n\nThis fixes CVE-2026-12345.'),
    ).toBe(true);
  });

  it('ignores a changelog quoted deep in a renovate body (observed on a real run)', () => {
    // `fix(deps): update dependency axios to v1.20.0` tripped the pattern on a
    // CVE note in axios's own release notes, pasted a hundred lines down.
    const renovateBody = [
      'fix(deps): update dependency axios to v1.20.0 (#3649)',
      '',
      'This PR contains the following updates:',
      '| Package | Change |',
      '|---|---|',
      '| axios | `1.19.0` -> `1.20.0` |',
      ...Array.from({ length: 40 }, (_, i) => `filler line ${String(i)} of the renovate table`),
      '### Release Notes',
      'fixed a security vulnerability in the follow-redirects handling',
    ].join('\n');
    expect(hasSecuritySignal(renovateBody)).toBe(false);
  });
});

describe('triageCommit', () => {
  it('returns null when neither paths nor message are relevant', () => {
    expect(
      triageCommit(
        commit({ sha: 'a'.repeat(40), files: ['frontend/x.vue', 'pkg/swagger/docs.go'] }),
      ),
    ).toBeNull();
  });

  it('reports a watched path with the commit that explains it', () => {
    const finding = triageCommit(
      commit({
        sha: 'b'.repeat(40),
        message: 'fix(routes): rate limit basic auth failures\n\nlong body',
        files: ['pkg/routes/rate_limit.go', 'pkg/routes/rate_limit_test.go'],
      }),
    );
    expect(finding).not.toBeNull();
    expect(finding?.subject).toBe('fix(routes): rate limit basic auth failures');
    expect(finding?.shortSha).toBe('bbbbbbbb');
    expect(finding?.paths).toEqual(['pkg/routes/rate_limit.go']);
    expect(finding?.securitySignal).toBe(false);
  });

  it('reports a security fix even when it touches nothing we watch', () => {
    const finding = triageCommit(
      commit({
        sha: 'c'.repeat(40),
        message: 'fix: security hole in the avatar cache',
        files: ['pkg/modules/avatar/cache.go'],
      }),
    );
    expect(finding?.securitySignal).toBe(true);
    expect(finding?.paths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Watermark storage
// ---------------------------------------------------------------------------

describe('watermark parsing and writing', () => {
  const watermark = { sha: 'a'.repeat(40), date: '2026-08-31T18:13:05Z' };

  it('round-trips through an issue body', () => {
    const body = applyWatermark('Some human-written tracker prose.\n', watermark);
    expect(parseWatermark(body)).toEqual(watermark);
  });

  it('returns null for a body that has never been stamped (a first run)', () => {
    expect(
      parseWatermark('Watermark: not yet initialised — the first run will set it.'),
    ).toBeNull();
  });

  it('returns null rather than a bad window when the marker is malformed', () => {
    expect(parseWatermark('<!-- upstream-watch:watermark sha=zzz date=nope -->')).toBeNull();
    expect(
      parseWatermark(`<!-- upstream-watch:watermark sha=${'a'.repeat(40)} date=never -->`),
    ).toBeNull();
  });

  it('appends the marker without disturbing the existing body', () => {
    const body = '## Why this exists\n\nProse the owner wrote.\n';
    const updated = applyWatermark(body, watermark);
    expect(updated).toContain('## Why this exists');
    expect(updated).toContain('Prose the owner wrote.');
    expect(updated).toContain(renderWatermarkLine(watermark));
  });

  it('replaces the marker line in place on the next run, leaving one marker', () => {
    const first = applyWatermark('prose\n', watermark);
    const second = applyWatermark(first, { sha: 'b'.repeat(40), date: '2026-09-07T09:00:00Z' });
    expect(second.match(/upstream-watch:watermark/g)).toHaveLength(1);
    expect(parseWatermark(second)?.sha).toBe('b'.repeat(40));
    expect(second.split('\n').length).toBe(first.split('\n').length);
  });

  it('carries a human-readable half so the issue explains itself', () => {
    expect(renderWatermarkLine(watermark)).toContain('Watermark: `aaaaaaaa`');
  });
});

// ---------------------------------------------------------------------------
// Window resolution + bounding
// ---------------------------------------------------------------------------

describe('resolveWindow', () => {
  const now = new Date('2026-08-31T00:00:00Z');

  it('starts at the stored watermark when there is one', () => {
    const window = resolveWindow({
      watermark: { sha: 'd'.repeat(40), date: '2026-08-24T00:00:00Z' },
      now,
    });
    expect(window).toMatchObject({
      sinceIso: '2026-08-24T00:00:00Z',
      mode: 'watermark',
      watermarkSha: 'd'.repeat(40),
    });
  });

  it('bounds a first run to a fixed lookback instead of all of history', () => {
    const window = resolveWindow({ watermark: null, now });
    expect(window.mode).toBe('first-run');
    expect(window.watermarkSha).toBeNull();
    expect(window.sinceIso).toBe('2026-08-17T00:00:00.000Z'); // 14 days
    expect(window.reason).toContain('14 days');
  });

  it('honours an explicit lookback override', () => {
    expect(resolveWindow({ watermark: null, now, lookbackDays: 3 }).sinceIso).toBe(
      '2026-08-28T00:00:00.000Z',
    );
  });
});

describe('boundCommits', () => {
  it('passes a window through untouched when it fits', () => {
    expect(boundCommits([1, 2, 3], 10)).toEqual({
      processed: [1, 2, 3],
      deferred: 0,
      truncated: false,
    });
  });

  it('processes the OLDEST slice so nothing untriaged is left behind the watermark', () => {
    // Input is oldest-first. Taking the NEWEST n and advancing past the rest is
    // the silent-gap bug this rule exists to prevent.
    const bounded = boundCommits([1, 2, 3, 4, 5], 2);
    expect(bounded).toEqual({ processed: [1, 2], deferred: 3, truncated: true });
  });

  it('defaults to the documented per-run cap', () => {
    const many = Array.from({ length: MAX_COMMITS_PER_RUN + 5 }, (_, i) => i);
    expect(boundCommits(many).deferred).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

describe('runUpstreamWatch', () => {
  const now = new Date('2026-08-31T12:00:00Z');

  it('reports nothing, and stays exit-code-0 material, when the window holds no relevant work', async () => {
    const upstream = new FakeUpstream(
      [
        {
          sha: '1'.repeat(40),
          date: '2026-08-30T10:00:00Z',
          message: 'chore(deps): bump vue',
          author: 'bot',
          url: 'u1',
        },
        {
          sha: '2'.repeat(40),
          date: '2026-08-29T10:00:00Z',
          message: 'docs: fix typo',
          author: 'bot',
          url: 'u2',
        },
      ],
      { ['1'.repeat(40)]: ['frontend/package.json'], ['2'.repeat(40)]: ['docs/readme.md'] },
    );

    const digest = await runUpstreamWatch(upstream, { watermark: null, now });

    expect(digest.status).toBe('empty');
    expect(digest.findings).toEqual([]);
    expect(digest.scanned).toBe(2);
    // Still advances: irrelevant commits must not be re-examined every week.
    expect(digest.nextWatermark).toEqual({ sha: '1'.repeat(40), date: '2026-08-30T10:00:00Z' });
  });

  it('finds the relevant commits and points the watermark at the newest commit examined', async () => {
    const upstream = new FakeUpstream(
      [
        {
          sha: '3'.repeat(40),
          date: '2026-08-30T16:00:00Z',
          message: 'fix(routes): rate limit basic auth failures',
          author: 'kolaente',
          url: 'u3',
        },
        {
          sha: '4'.repeat(40),
          date: '2026-08-29T16:00:00Z',
          message: 'chore(deps): update crowdin action',
          author: 'bot',
          url: 'u4',
        },
        {
          sha: '5'.repeat(40),
          date: '2026-08-28T16:00:00Z',
          message: 'feat(models): enforce view ownership on task position',
          author: 'kolaente',
          url: 'u5',
        },
      ],
      {
        ['3'.repeat(40)]: ['pkg/routes/rate_limit.go'],
        ['4'.repeat(40)]: ['.github/workflows/crowdin.yml'],
        ['5'.repeat(40)]: ['pkg/models/task_position.go', 'pkg/swagger/docs.go'],
      },
      [
        { name: 'v2.6.0', sha: '3'.repeat(40) },
        { name: 'v2.5.0', sha: '9'.repeat(40) },
      ],
    );

    const digest = await runUpstreamWatch(upstream, { watermark: null, now });

    expect(digest.status).toBe('findings');
    // Oldest first, as the digest reads chronologically.
    expect(digest.findings.map((f) => f.sha)).toEqual(['5'.repeat(40), '3'.repeat(40)]);
    expect(digest.findings[0]?.paths).toEqual(['pkg/models/task_position.go']);
    expect(digest.nextWatermark?.sha).toBe('3'.repeat(40));
    // Only tags whose target commit is inside this window.
    expect(digest.tags).toEqual([{ name: 'v2.6.0', sha: '3'.repeat(40) }]);
  });

  it('excludes the watermark commit from its own window (GitHub `since` is inclusive)', async () => {
    const watermark = { sha: '6'.repeat(40), date: '2026-08-25T00:00:00Z' };
    const upstream = new FakeUpstream(
      [
        {
          sha: '7'.repeat(40),
          date: '2026-08-26T00:00:00Z',
          message: 'feat(models): new field',
          author: 'dev',
          url: 'u7',
        },
        {
          sha: '6'.repeat(40),
          date: '2026-08-25T00:00:00Z',
          message: 'feat(models): already triaged',
          author: 'dev',
          url: 'u6',
        },
      ],
      { ['7'.repeat(40)]: ['pkg/models/tasks.go'], ['6'.repeat(40)]: ['pkg/models/tasks.go'] },
    );

    const digest = await runUpstreamWatch(upstream, { watermark, now });

    expect(upstream.listCommitsCalls).toEqual(['2026-08-25T00:00:00Z']);
    expect(digest.scanned).toBe(1);
    expect(digest.findings.map((f) => f.sha)).toEqual(['7'.repeat(40)]);
    expect(upstream.fileCalls).not.toContain('6'.repeat(40));
  });

  it('defers the tail of an oversized window instead of skipping it', async () => {
    const commits: UpstreamCommitSummary[] = Array.from({ length: 5 }, (_, i) => ({
      sha: String(i).repeat(40),
      // Newest first, as the API returns them.
      date: `2026-08-${String(20 + (4 - i)).padStart(2, '0')}T00:00:00Z`,
      message: 'feat(models): change',
      author: 'dev',
      url: `u${String(i)}`,
    }));
    const files = Object.fromEntries(commits.map((c) => [c.sha, ['pkg/models/tasks.go']]));
    const upstream = new FakeUpstream(commits, files);

    const digest = await runUpstreamWatch(upstream, { watermark: null, now, maxCommits: 2 });

    expect(digest.truncated).toBe(true);
    expect(digest.deferred).toBe(3);
    expect(digest.scanned).toBe(2);
    // The two OLDEST were examined, and the watermark stops at the newer of
    // those — the three untriaged commits are still ahead of it.
    expect(digest.findings.map((f) => f.sha)).toEqual([String(4).repeat(40), String(3).repeat(40)]);
    expect(digest.nextWatermark?.sha).toBe(String(3).repeat(40));
  });

  it('leaves the watermark alone when the window is empty', async () => {
    const digest = await runUpstreamWatch(new FakeUpstream([]), {
      watermark: { sha: '8'.repeat(40), date: '2026-08-30T00:00:00Z' },
      now,
    });
    expect(digest.status).toBe('empty');
    expect(digest.scanned).toBe(0);
    expect(digest.nextWatermark).toBeNull();
  });

  it('propagates a transport failure instead of reporting an empty window', async () => {
    const failing: UpstreamClient = {
      listCommits: () => Promise.reject(new Error('502 Bad Gateway')),
      listCommitFiles: () => Promise.resolve([]),
      listTags: () => Promise.resolve([]),
    };
    // "Nothing found" and "could not look" must never be the same outcome.
    await expect(runUpstreamWatch(failing, { watermark: null, now })).rejects.toThrow('502');
  });
});

// ---------------------------------------------------------------------------
// Rendering + exit semantics
// ---------------------------------------------------------------------------

describe('renderDigestMarkdown', () => {
  const base = {
    tags: [] as UpstreamTag[],
    window: {
      sinceIso: '2026-08-24T00:00:00Z',
      mode: 'watermark' as const,
      watermarkSha: 'e'.repeat(40),
      reason: 'since the last triaged commit eeeeeeee',
    },
    deferred: 0,
    truncated: false,
    generatedAt: new Date('2026-08-31T12:00:00Z'),
  };

  it('renders a dated section naming each commit and its watched paths', () => {
    const digest = buildDigest({
      ...base,
      commits: [
        commit({
          sha: 'f'.repeat(40),
          message: 'fix(models): archived projects refuse writes',
          files: ['pkg/models/project.go'],
        }),
      ],
    });
    const markdown = renderDigestMarkdown(digest);
    expect(markdown).toContain('## 2026-08-31 — 1 relevant commit');
    expect(markdown).toContain('fix(models): archived projects refuse writes');
    expect(markdown).toContain('`pkg/models/project.go`');
    expect(markdown).toContain(`https://github.com/go-vikunja/vikunja/commit/${'f'.repeat(40)}`);
  });

  it('marks a security signal and explains a message-only match', () => {
    const digest = buildDigest({
      ...base,
      commits: [
        commit({
          sha: '0'.repeat(40),
          message: 'fix: security issue in link shares',
          files: ['pkg/x/y.go'],
        }),
      ],
    });
    const markdown = renderDigestMarkdown(digest);
    expect(markdown).toContain('[security signal]');
    expect(markdown).toContain('flagged by its commit message alone');
  });

  it('says so, loudly, when the window was capped', () => {
    const digest = buildDigest({
      ...base,
      truncated: true,
      deferred: 12,
      commits: [commit({ sha: '1'.repeat(40), files: ['pkg/models/tasks.go'] })],
    });
    expect(renderDigestMarkdown(digest)).toContain('12 older commits remain untriaged');
  });

  it('carries the caller-supplied note (the workflow states its triage status here)', () => {
    const digest = buildDigest({
      ...base,
      commits: [commit({ sha: '2'.repeat(40), files: ['pkg/models/a.go'] })],
    });
    expect(renderDigestMarkdown(digest, 'Agent triage skipped: no ANTHROPIC_API_KEY.')).toContain(
      'Agent triage skipped',
    );
  });

  it('lists tags that landed inside the window', () => {
    const digest = buildDigest({
      ...base,
      tags: [{ name: 'v2.6.0', sha: '3'.repeat(40) }],
      commits: [commit({ sha: '3'.repeat(40), files: ['pkg/models/a.go'] })],
    });
    expect(renderDigestMarkdown(digest)).toContain('`v2.6.0`');
  });
});

describe('EXIT_CODES', () => {
  it('keeps "nothing relevant", "findings" and "failed" distinguishable', () => {
    expect(EXIT_CODES.EMPTY).toBe(0);
    expect(EXIT_CODES.FAILURE).toBe(1);
    expect(EXIT_CODES.FINDINGS).toBe(10);
    expect(new Set(Object.values(EXIT_CODES)).size).toBe(3);
  });
});
