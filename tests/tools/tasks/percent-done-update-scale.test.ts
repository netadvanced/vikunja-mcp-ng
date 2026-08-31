/**
 * `percentDone` scale coverage for the UPDATE path.
 *
 * The tool surface takes a whole percentage 0-100; `POST /tasks/{id}` must
 * receive Vikunja's 0-1 fraction. `updateTask` is exported and reachable
 * without the Zod schema in front of it, so it carries its own guard — these
 * tests assert the WIRE payload and the teaching error, not merely that a
 * helper was called.
 *
 * See src/utils/percent-done.ts and decision 22 in docs/ROADMAP.md §3.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AuthManager } from '../../../src/auth/AuthManager';
import { updateTask } from '../../../src/tools/tasks/crud';
import { circuitBreakerRegistry } from '../../../src/utils/retry';

jest.mock('../../../src/utils/logger');

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function mockResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: jest.fn(async () => text),
  } as unknown as Response;
}

interface FetchCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

function fetchCalls(): FetchCall[] {
  return mockFetch.mock.calls.map((call) => {
    const [url, init] = call as [string, { method?: string; body?: string } | undefined];
    return {
      method: init?.method ?? 'GET',
      path: new URL(url).pathname.replace(/^\/api\/v\d+/, ''),
      body:
        init?.body !== undefined ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
  });
}

/** The decoded body of the POST /tasks/{id} update request. */
function updateBody(): Record<string, unknown> {
  const call = fetchCalls().find((c) => c.method === 'POST' && /^\/tasks\/\d+$/.test(c.path));
  if (!call) throw new Error('no update request was sent');
  return call.body as Record<string, unknown>;
}

/** Every request resolves to the same stored task, with `stored` merged in. */
function routeUpdate(stored: Record<string, unknown> = {}): void {
  mockFetch.mockImplementation(async () =>
    mockResponse(JSON.stringify({ id: 7, title: 'T', project_id: 1, ...stored })),
  );
}

describe('updateTask — percentDone scale', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  it.each([
    [0, 0],
    [25, 0.25],
    [75, 0.75],
    [100, 1],
  ])('sends percentDone %i as percent_done %f on the wire', async (percentage, fraction) => {
    routeUpdate();

    await updateTask({ id: 7, percentDone: percentage }, authManager);

    expect(updateBody()).toHaveProperty('percent_done', fraction);
  });

  it('reads percentDone: 1 as one percent, not as "done"', async () => {
    routeUpdate();

    await updateTask({ id: 7, percentDone: 1 }, authManager);

    // Under the old 0-1 contract this exact call silently marked the task
    // 100% complete — the silent-wrong-data failure the integer percentage
    // scale exists to remove.
    expect(updateBody()).toHaveProperty('percent_done', 0.01);
  });

  it('rejects a fraction with a message that teaches the scale', async () => {
    await expect(updateTask({ id: 7, percentDone: 0.5 }, authManager)).rejects.toThrow(
      'percentDone must be a whole number between 0 and 100',
    );
    await expect(updateTask({ id: 7, percentDone: 0.5 }, authManager)).rejects.toThrow(
      'use 50 for 50%',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([-1, 101])('rejects %i before any request is sent', async (value) => {
    await expect(updateTask({ id: 7, percentDone: value }, authManager)).rejects.toThrow(
      'percentDone must be a whole number between 0 and 100',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not report percentDone as changed when it already matches, compared in wire space', async () => {
    routeUpdate({ percent_done: 0.75 });

    const result = await updateTask({ id: 7, percentDone: 75, title: 'Renamed' }, authManager);

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('title');
    // The comparison happens after converting to the wire scale; comparing the
    // raw 75 against the stored 0.75 would always look like a change.
    expect(text).not.toContain('percentDone');
  });

  it('does report percentDone as changed when the value actually differs', async () => {
    routeUpdate({ percent_done: 0.25 });

    const result = await updateTask({ id: 7, percentDone: 75 }, authManager);

    expect(result.content[0]?.text ?? '').toContain('percentDone');
  });
});
