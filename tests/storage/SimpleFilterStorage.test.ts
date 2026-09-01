/**
 * Unit tests for SimpleFilterStorage.touch() and the FilterStorageManager
 * idle-eviction race it fixes (#264 CRIT-3 combined with #293 MED-11 — see
 * src/tools/templates.ts's hydration doc comment for the full mechanism).
 *
 * These construct dedicated `FilterStorageManager` instances rather than
 * using the module-level `storageManager` singleton, so each test controls
 * its own cleanup timer under fake timers without interfering with others.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { SimpleFilterStorage, FilterStorageManager } from '../../src/storage/SimpleFilterStorage';

describe('SimpleFilterStorage.touch', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('bumps lastAccessAt without touching any filter data', () => {
    const storage = new SimpleFilterStorage('session-1');
    const before = storage.getSession().lastAccessAt.getTime();

    jest.advanceTimersByTime(1000);
    storage.touch();

    const session = storage.getSession();
    expect(session.lastAccessAt.getTime()).toBeGreaterThan(before);
    expect(session.id).toBe('session-1');
  });
});

describe('FilterStorageManager idle-eviction race (#264 / MED-11)', () => {
  let manager: FilterStorageManager;

  beforeEach(() => {
    jest.useFakeTimers();
    manager = new FilterStorageManager();
  });

  afterEach(() => {
    manager.stopCleanupTimer();
    jest.useRealTimers();
  });

  it('getStorage bumps lastAccessAt on every lookup, not just on filter CRUD calls', async () => {
    const storage = await manager.getStorage('session-1');
    const t0 = storage.getSession().lastAccessAt.getTime();

    await jest.advanceTimersByTimeAsync(30 * 60 * 1000); // 30 min, no CRUD calls at all
    await manager.getStorage('session-1'); // a mere lookup

    const t1 = storage.getSession().lastAccessAt.getTime();
    expect(t1).toBeGreaterThan(t0);
  });

  it('an active session survives the 1h idle sweep as long as it keeps being looked up', async () => {
    await manager.getStorage('active-session');

    // "Active" here means only ever *looked up* (getStorage), never
    // mutated — the exact shape of templates.ts's hydration check, which
    // reads via findByName/list rather than always writing. Before the
    // #264/MED-11 fix, getStorage never reset the idle clock on its own,
    // so a session that was only ever looked up (not mutated) could still
    // be evicted by the sweep even while genuinely in active use.
    for (let i = 0; i < 3; i++) {
      await jest.advanceTimersByTimeAsync(50 * 60 * 1000); // 50 min between lookups
      await manager.getStorage('active-session');
    }

    // Let the (also 1h-interval) cleanup sweep run at least once more.
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);

    const stats = await manager.getAllStats();
    expect(stats.some((s) => s.sessionId === 'active-session')).toBe(true);
  });

  it('a genuinely idle session (never looked up again) is still evicted by the cleanup sweep', async () => {
    await manager.getStorage('idle-session');

    // The sweep timer fires every 1h starting from manager construction. Its
    // *first* tick (t=60min) sees exactly 60min of idle time, which the
    // sweep's `>` comparison does not treat as expired yet — eviction only
    // lands on the *second* tick (t=120min), once idle time is unambiguously
    // past the threshold. Advancing past two full ticks makes this
    // deterministic rather than depending on that boundary.
    await jest.advanceTimersByTimeAsync(121 * 60 * 1000);

    const stats = await manager.getAllStats();
    expect(stats.some((s) => s.sessionId === 'idle-session')).toBe(false);
  });

  it('after eviction, the next getStorage call for the same session id returns a brand-new, empty instance', async () => {
    const first = await manager.getStorage('evicted-session');
    await first.create({ name: 'template_1', filter: '{}', isGlobal: true, namespace: 'template' });

    await jest.advanceTimersByTimeAsync(121 * 60 * 1000);

    const second = await manager.getStorage('evicted-session');
    expect(second).not.toBe(first);
    expect(await second.list()).toEqual([]);
  });
});
