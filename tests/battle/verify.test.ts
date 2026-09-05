import { runVerification } from '../../scripts/battle/lib/verify';
import type { VerifyCheck } from '../../scripts/battle/types';
import { FakeRestClient } from './helpers/fake-rest-client';

function scenario(): { id: string } {
  return { id: 'fixture' };
}

describe('runVerification / project-exists', () => {
  it('passes when a project with a matching title substring exists', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 1, title: 'battle-abc-Q3 Offsite' }];
    const checks: VerifyCheck[] = [{ type: 'project-exists', titleContains: 'Q3 Offsite' }];

    const verdict = await runVerification(scenario(), checks, client);

    expect(verdict.passed).toBe(true);
    expect(verdict.checks[0]?.passed).toBe(true);
  });

  it('fails when no project title contains the substring', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 1, title: 'battle-abc-Unrelated' }];
    const checks: VerifyCheck[] = [{ type: 'project-exists', titleContains: 'Q3 Offsite' }];

    const verdict = await runVerification(scenario(), checks, client);

    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.detail).toContain('no project with title containing');
  });
});

describe('runVerification / min-tasks-in-project', () => {
  it('fails cleanly when the project itself does not exist', async () => {
    const client = new FakeRestClient();
    const checks: VerifyCheck[] = [
      { type: 'min-tasks-in-project', projectTitleContains: 'nope', min: 1 },
    ];
    const verdict = await runVerification(scenario(), checks, client);
    expect(verdict.passed).toBe(false);
  });

  it('passes only once the task count reaches min', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 5, title: 'battle-x-Sprint' }];
    client.tasksByProject[5] = [
      { id: 1, title: 't1', project_id: 5 },
      { id: 2, title: 't2', project_id: 5 },
    ];
    const checks: VerifyCheck[] = [
      { type: 'min-tasks-in-project', projectTitleContains: 'Sprint', min: 3 },
    ];
    expect((await runVerification(scenario(), checks, client)).passed).toBe(false);

    client.tasksByProject[5]!.push({ id: 3, title: 't3', project_id: 5 });
    expect((await runVerification(scenario(), checks, client)).passed).toBe(true);
  });
});

describe('runVerification / min-buckets-in-project', () => {
  it("counts buckets returned for the resolved project (kanban-view resolution is RestClient's own concern, per the VikunjaRestClient contract)", async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 7, title: 'battle-x-Board' }];
    client.buckets[7] = [
      { id: 10, title: 'To do' },
      { id: 11, title: 'Doing' },
      { id: 12, title: 'Done' },
    ];
    const checks: VerifyCheck[] = [
      { type: 'min-buckets-in-project', projectTitleContains: 'Board', min: 3 },
    ];
    const verdict = await runVerification(scenario(), checks, client);
    expect(verdict.passed).toBe(true);
  });

  it('fails when there are fewer buckets than required', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 7, title: 'battle-x-Board' }];
    client.buckets[7] = [{ id: 10, title: 'To do' }];
    const checks: VerifyCheck[] = [
      { type: 'min-buckets-in-project', projectTitleContains: 'Board', min: 3 },
    ];
    const verdict = await runVerification(scenario(), checks, client);
    expect(verdict.passed).toBe(false);
  });
});

describe('runVerification / buckets-with-tasks-count', () => {
  it('counts only buckets whose `count` field is greater than zero, distinguishing "buckets exist" from "tasks were actually moved into them"', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 7, title: 'battle-x-Sprint Board' }];
    client.buckets[7] = [
      { id: 10, title: 'To Do', count: 3 },
      { id: 11, title: 'Doing', count: 3 },
      { id: 12, title: 'Done', count: 0 },
    ];
    const checks: VerifyCheck[] = [
      { type: 'buckets-with-tasks-count', projectTitleContains: 'Sprint Board', min: 3 },
    ];
    const verdict = await runVerification(scenario(), checks, client);
    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.detail).toContain('2/3');
  });

  it('passes once every targeted bucket holds at least one task', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 7, title: 'battle-x-Sprint Board' }];
    client.buckets[7] = [
      { id: 10, title: 'To Do', count: 3 },
      { id: 11, title: 'Doing', count: 3 },
      { id: 12, title: 'Done', count: 3 },
    ];
    const checks: VerifyCheck[] = [
      { type: 'buckets-with-tasks-count', projectTitleContains: 'Sprint Board', min: 3 },
    ];
    expect((await runVerification(scenario(), checks, client)).passed).toBe(true);
  });

  it('fails cleanly when the project itself does not exist', async () => {
    const client = new FakeRestClient();
    const checks: VerifyCheck[] = [
      { type: 'buckets-with-tasks-count', projectTitleContains: 'nope', min: 1 },
    ];
    expect((await runVerification(scenario(), checks, client)).passed).toBe(false);
  });

  it('treats a bucket with an undefined `count` as empty', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 7, title: 'battle-x-Board' }];
    client.buckets[7] = [{ id: 10, title: 'To Do' }];
    const checks: VerifyCheck[] = [
      { type: 'buckets-with-tasks-count', projectTitleContains: 'Board', min: 1 },
    ];
    expect((await runVerification(scenario(), checks, client)).passed).toBe(false);
  });
});

describe('runVerification / tasks-field-match-count', () => {
  const client = new FakeRestClient();
  client.projects = [{ id: 1, title: 'battle-x-P' }];
  client.tasksByProject[1] = [
    { id: 1, title: 'a', project_id: 1, priority: 5, done: true },
    { id: 2, title: 'b', project_id: 1, priority: 1, done: false },
    { id: 3, title: 'c', project_id: 1, priority: 0, done: false },
  ];

  it('supports "set" (non-default value present)', async () => {
    const checks: VerifyCheck[] = [
      {
        type: 'tasks-field-match-count',
        projectTitleContains: 'P',
        field: 'priority',
        op: 'set',
        min: 2,
      },
    ];
    expect((await runVerification(scenario(), checks, client)).passed).toBe(true);
  });

  it('supports "gte"', async () => {
    const checks: VerifyCheck[] = [
      {
        type: 'tasks-field-match-count',
        projectTitleContains: 'P',
        field: 'priority',
        op: 'gte',
        value: 5,
        min: 1,
      },
    ];
    expect((await runVerification(scenario(), checks, client)).passed).toBe(true);
  });

  it('supports "eq" on a boolean field (done)', async () => {
    const checks: VerifyCheck[] = [
      {
        type: 'tasks-field-match-count',
        projectTitleContains: 'P',
        field: 'done',
        op: 'eq',
        value: true,
        min: 1,
      },
    ];
    expect((await runVerification(scenario(), checks, client)).passed).toBe(true);

    const checksTooMany: VerifyCheck[] = [
      {
        type: 'tasks-field-match-count',
        projectTitleContains: 'P',
        field: 'done',
        op: 'eq',
        value: true,
        min: 2,
      },
    ];
    expect((await runVerification(scenario(), checksTooMany, client)).passed).toBe(false);
  });
});

describe('runVerification / tasks-due-date-in-range', () => {
  it('excludes Vikunja\'s "no due date" epoch sentinel from matching any range', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 1, title: 'battle-x-P' }];
    client.tasksByProject[1] = [
      { id: 1, title: 'a', project_id: 1, due_date: '0001-01-01T00:00:00Z' },
      { id: 2, title: 'b', project_id: 1, due_date: '2026-09-15T00:00:00Z' },
    ];
    const checks: VerifyCheck[] = [
      {
        type: 'tasks-due-date-in-range',
        projectTitleContains: 'P',
        startDate: '2026-09-01T00:00:00Z',
        endDate: '2026-09-30T23:59:59Z',
        min: 2,
      },
    ];
    const verdict = await runVerification(scenario(), checks, client);
    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.detail).toContain('1/2');
  });
});

describe('runVerification / label-exists and tasks-with-label-count', () => {
  it('finds labels by substring and counts tasks carrying them via the per-task labels endpoint', async () => {
    const client = new FakeRestClient();
    client.labels = [{ id: 1, title: 'battle-x-urgent' }];
    client.projects = [{ id: 1, title: 'battle-x-Sprint' }];
    client.tasksByProject[1] = [
      { id: 10, title: 't1', project_id: 1 },
      { id: 11, title: 't2', project_id: 1 },
    ];
    client.labelsByTask[10] = [{ id: 1, title: 'battle-x-urgent' }];
    client.labelsByTask[11] = [];

    const labelCheck: VerifyCheck[] = [{ type: 'label-exists', titleContains: 'urgent' }];
    expect((await runVerification(scenario(), labelCheck, client)).passed).toBe(true);

    const countCheck: VerifyCheck[] = [
      {
        type: 'tasks-with-label-count',
        projectTitleContains: 'Sprint',
        labelTitleContains: 'urgent',
        min: 1,
      },
    ];
    expect((await runVerification(scenario(), countCheck, client)).passed).toBe(true);

    const countCheckTooMany: VerifyCheck[] = [
      {
        type: 'tasks-with-label-count',
        projectTitleContains: 'Sprint',
        labelTitleContains: 'urgent',
        min: 2,
      },
    ];
    expect((await runVerification(scenario(), countCheckTooMany, client)).passed).toBe(false);
  });
});

describe('runVerification / task-has-subtasks', () => {
  it("reads subtasks off the parent's related_tasks.subtask array", async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 1, title: 'battle-x-Launch' }];
    client.tasksByProject[1] = [
      {
        id: 1,
        title: 'battle-x-Prepare launch',
        project_id: 1,
        related_tasks: {
          subtask: [
            { id: 2, title: 'child1', project_id: 1 },
            { id: 3, title: 'child2', project_id: 1 },
          ],
        },
      },
    ];
    const checks: VerifyCheck[] = [
      {
        type: 'task-has-subtasks',
        projectTitleContains: 'Launch',
        parentTitleContains: 'Prepare launch',
        min: 2,
      },
    ];
    expect((await runVerification(scenario(), checks, client)).passed).toBe(true);

    const tooMany: VerifyCheck[] = [
      {
        type: 'task-has-subtasks',
        projectTitleContains: 'Launch',
        parentTitleContains: 'Prepare launch',
        min: 3,
      },
    ];
    expect((await runVerification(scenario(), tooMany, client)).passed).toBe(false);
  });

  it('fails when no task matches the parent title substring', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 1, title: 'battle-x-Launch' }];
    client.tasksByProject[1] = [{ id: 1, title: 'unrelated', project_id: 1 }];
    const checks: VerifyCheck[] = [
      {
        type: 'task-has-subtasks',
        projectTitleContains: 'Launch',
        parentTitleContains: 'Prepare launch',
        min: 1,
      },
    ];
    expect((await runVerification(scenario(), checks, client)).passed).toBe(false);
  });
});

describe('runVerification / project-has-share', () => {
  it('passes once at least one link share exists', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 1, title: 'battle-x-Roadmap' }];
    client.shares[1] = [{ id: 1, hash: 'abc' }];
    const checks: VerifyCheck[] = [{ type: 'project-has-share', projectTitleContains: 'Roadmap' }];
    expect((await runVerification(scenario(), checks, client)).passed).toBe(true);
  });

  it('fails when there are zero shares', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 1, title: 'battle-x-Roadmap' }];
    const checks: VerifyCheck[] = [{ type: 'project-has-share', projectTitleContains: 'Roadmap' }];
    expect((await runVerification(scenario(), checks, client)).passed).toBe(false);
  });
});

describe('runVerification / buckets-in-order', () => {
  it('passes when buckets come back from the server in exactly the expected order', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 7, title: 'battle-x-Product Launch' }];
    client.buckets[7] = [
      { id: 10, title: 'Backlog' },
      { id: 11, title: 'In Progress' },
      { id: 12, title: 'Review' },
      { id: 13, title: 'Done' },
    ];
    const checks: VerifyCheck[] = [
      {
        type: 'buckets-in-order',
        projectTitleContains: 'Product Launch',
        order: ['Backlog', 'In Progress', 'Review', 'Done'],
      },
    ];
    const verdict = await runVerification(scenario(), checks, client);
    expect(verdict.passed).toBe(true);
  });

  it('fails when the first expected column lands last (issue #173 regression shape)', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 7, title: 'battle-x-Product Launch' }];
    // Reproduces the coordinator's live probe: sending position 0 for the
    // FIRST column let the server substitute its own id-derived default,
    // pushing that column to the back of the returned order.
    client.buckets[7] = [
      { id: 11, title: 'In Progress' },
      { id: 12, title: 'Review' },
      { id: 13, title: 'Done' },
      { id: 10, title: 'Backlog' },
    ];
    const checks: VerifyCheck[] = [
      {
        type: 'buckets-in-order',
        projectTitleContains: 'Product Launch',
        order: ['Backlog', 'In Progress', 'Review', 'Done'],
      },
    ];
    const verdict = await runVerification(scenario(), checks, client);
    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.detail).toContain('Backlog');
  });

  it('ignores buckets not named in `order` (e.g. a leftover default bucket in a reuse scenario)', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 7, title: 'battle-x-Board' }];
    client.buckets[7] = [
      { id: 10, title: 'To Do' },
      { id: 99, title: 'Unclaimed Leftover' },
      { id: 11, title: 'Doing' },
      { id: 12, title: 'Done' },
    ];
    const checks: VerifyCheck[] = [
      {
        type: 'buckets-in-order',
        projectTitleContains: 'Board',
        order: ['To Do', 'Doing', 'Done'],
      },
    ];
    const verdict = await runVerification(scenario(), checks, client);
    expect(verdict.passed).toBe(true);
  });

  it('matches column names case-insensitively', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 7, title: 'battle-x-Board' }];
    client.buckets[7] = [
      { id: 10, title: 'to do' },
      { id: 11, title: 'DOING' },
    ];
    const checks: VerifyCheck[] = [
      { type: 'buckets-in-order', projectTitleContains: 'Board', order: ['To Do', 'Doing'] },
    ];
    const verdict = await runVerification(scenario(), checks, client);
    expect(verdict.passed).toBe(true);
  });

  it('fails when an expected column is missing entirely', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 7, title: 'battle-x-Board' }];
    client.buckets[7] = [
      { id: 10, title: 'To Do' },
      { id: 11, title: 'Doing' },
    ];
    const checks: VerifyCheck[] = [
      {
        type: 'buckets-in-order',
        projectTitleContains: 'Board',
        order: ['To Do', 'Doing', 'Done'],
      },
    ];
    const verdict = await runVerification(scenario(), checks, client);
    expect(verdict.passed).toBe(false);
  });

  it('fails cleanly when the project itself does not exist', async () => {
    const client = new FakeRestClient();
    const checks: VerifyCheck[] = [
      { type: 'buckets-in-order', projectTitleContains: 'nope', order: ['To Do', 'Done'] },
    ];
    const verdict = await runVerification(scenario(), checks, client);
    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.detail).toContain('no project with title containing');
  });
});

describe('runVerification / tasks-with-label-count max bound', () => {
  function clientWithLabelledTasks(labelledCount: number): FakeRestClient {
    const client = new FakeRestClient();
    client.projects = [{ id: 1, title: 'battle-x-Q4 Rollout' }];
    client.tasksByProject[1] = [1, 2, 3, 4, 5].map((id) => ({
      id,
      title: `battle-x-task-${id}`,
      project_id: 1,
    }));
    for (let id = 1; id <= labelledCount; id += 1) {
      client.labelsByTask[id] = [{ id: 90, title: 'battle-x-nearly-there' }];
    }
    return client;
  }

  const exactlyTwo: VerifyCheck[] = [
    {
      type: 'tasks-with-label-count',
      projectTitleContains: 'Q4 Rollout',
      labelTitleContains: 'nearly-there',
      min: 2,
      max: 2,
    },
  ];

  it('passes when the labelled count is exactly on the bound', async () => {
    const verdict = await runVerification(scenario(), exactlyTwo, clientWithLabelledTasks(2));
    expect(verdict.passed).toBe(true);
    expect(verdict.checks[0]?.detail).toContain('<= 2');
  });

  it('fails when too FEW tasks carry the label (an unconverted threshold matches nothing)', async () => {
    const verdict = await runVerification(scenario(), exactlyTwo, clientWithLabelledTasks(0));
    expect(verdict.passed).toBe(false);
  });

  it('fails when too MANY tasks carry the label (the agent gave up and labelled everything)', async () => {
    const verdict = await runVerification(scenario(), exactlyTwo, clientWithLabelledTasks(5));
    expect(verdict.passed).toBe(false);
  });

  it('ignores an upper bound that was not specified', async () => {
    const checks: VerifyCheck[] = [
      {
        type: 'tasks-with-label-count',
        projectTitleContains: 'Q4 Rollout',
        labelTitleContains: 'nearly-there',
        min: 2,
      },
    ];
    const verdict = await runVerification(scenario(), checks, clientWithLabelledTasks(5));
    expect(verdict.passed).toBe(true);
    expect(verdict.checks[0]?.detail).not.toContain('<=');
  });
});

describe('runVerification / task-absent-from-project', () => {
  function client(): FakeRestClient {
    const c = new FakeRestClient();
    c.projects = [{ id: 1, title: 'battle-x-Sprint Triage' }];
    return c;
  }

  it('passes when no task in the project matches the title substring', async () => {
    const c = client();
    c.tasksByProject[1] = [
      { id: 1, title: 'battle-x-item-1', project_id: 1 },
      { id: 2, title: 'battle-x-item-2', project_id: 1 },
    ];
    const checks: VerifyCheck[] = [
      {
        type: 'task-absent-from-project',
        projectTitleContains: 'Sprint Triage',
        titleContains: 'item-3',
      },
    ];
    const verdict = await runVerification(scenario(), checks, c);
    expect(verdict.passed).toBe(true);
  });

  it('fails when the task was re-created to paper over a partial bulk failure', async () => {
    const c = client();
    c.tasksByProject[1] = [
      { id: 1, title: 'battle-x-item-1', project_id: 1 },
      { id: 9, title: 'battle-x-item-3', project_id: 1 },
    ];
    const checks: VerifyCheck[] = [
      {
        type: 'task-absent-from-project',
        projectTitleContains: 'Sprint Triage',
        titleContains: 'item-3',
      },
    ];
    const verdict = await runVerification(scenario(), checks, c);
    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.detail).toContain('battle-x-item-3');
  });

  it('holds vacuously when the project does not exist (project-exists is the real diagnostic)', async () => {
    const checks: VerifyCheck[] = [
      { type: 'task-absent-from-project', projectTitleContains: 'nope', titleContains: 'item-3' },
    ];
    const verdict = await runVerification(scenario(), checks, new FakeRestClient());
    expect(verdict.passed).toBe(true);
    expect(verdict.checks[0]?.detail).toContain('vacuously');
  });
});

describe('runVerification / task-first-in-list-view', () => {
  function client(order: string[]): FakeRestClient {
    const c = new FakeRestClient();
    c.projects = [{ id: 1, title: 'battle-x-Reading List' }];
    c.listViewTasksByProject[1] = order.map((title, i) => ({
      id: i + 1,
      title,
      project_id: 1,
      position: (i + 1) * 16384,
    }));
    return c;
  }
  const checks: VerifyCheck[] = [
    {
      type: 'task-first-in-list-view',
      projectTitleContains: 'Reading List',
      titleContains: 'chapter-1',
    },
  ];

  it('passes when the named task heads the list view', async () => {
    const verdict = await runVerification(
      scenario(),
      checks,
      client(['battle-x-chapter-1', 'battle-x-chapter-2', 'battle-x-chapter-3']),
    );
    expect(verdict.passed).toBe(true);
  });

  it('fails when it sits anywhere else, and reports the observed order with positions', async () => {
    const verdict = await runVerification(
      scenario(),
      checks,
      client(['battle-x-chapter-3', 'battle-x-chapter-1']),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.detail).toContain('battle-x-chapter-3@16384');
  });

  it('fails when the list view is empty', async () => {
    const verdict = await runVerification(scenario(), checks, client([]));
    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.detail).toContain('none');
  });

  it('fails cleanly when the project does not exist', async () => {
    const other: VerifyCheck[] = [
      { type: 'task-first-in-list-view', projectTitleContains: 'nope', titleContains: 'x' },
    ];
    const verdict = await runVerification(scenario(), other, new FakeRestClient());
    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.detail).toContain('no project with title containing');
  });
});

describe('runVerification / team-exists', () => {
  function client(): FakeRestClient {
    const c = new FakeRestClient();
    c.teams = [
      {
        id: 7,
        name: 'battle-x-Design Chapter',
        is_public: true,
        members: [
          { id: 1, username: 'e2e-test', admin: true },
          { id: 2, username: 'e2e-mutable', admin: false },
        ],
      },
    ];
    return c;
  }

  it('passes on a bare name match', async () => {
    const checks: VerifyCheck[] = [{ type: 'team-exists', nameContains: 'Design Chapter' }];
    const verdict = await runVerification(scenario(), checks, client());
    expect(verdict.passed).toBe(true);
  });

  it('fails when no team matches the name substring', async () => {
    const checks: VerifyCheck[] = [{ type: 'team-exists', nameContains: 'Nope' }];
    const verdict = await runVerification(scenario(), checks, client());
    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.detail).toContain('no team with name containing');
  });

  it('passes when the raw is_public matches the expected visibility', async () => {
    const checks: VerifyCheck[] = [
      { type: 'team-exists', nameContains: 'Design Chapter', isPublic: true },
    ];
    const verdict = await runVerification(scenario(), checks, client());
    expect(verdict.passed).toBe(true);
  });

  it('fails when a partial update silently un-published the team', async () => {
    const c = client();
    (c.teams[0] as { is_public?: boolean }).is_public = false;
    const checks: VerifyCheck[] = [
      { type: 'team-exists', nameContains: 'Design Chapter', isPublic: true },
    ];
    const verdict = await runVerification(scenario(), checks, c);
    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.detail).toContain('is_public is false, expected true');
  });

  it('treats a missing is_public as false rather than as "unasserted"', async () => {
    const c = client();
    delete (c.teams[0] as { is_public?: boolean }).is_public;
    const checks: VerifyCheck[] = [
      { type: 'team-exists', nameContains: 'Design Chapter', isPublic: true },
    ];
    const verdict = await runVerification(scenario(), checks, c);
    expect(verdict.passed).toBe(false);
  });

  it('matches a member by username and asserts the admin flag', async () => {
    const checks: VerifyCheck[] = [
      {
        type: 'team-exists',
        nameContains: 'Design Chapter',
        hasMemberUsername: 'e2e-mutable',
        memberIsAdmin: false,
      },
    ];
    const verdict = await runVerification(scenario(), checks, client());
    expect(verdict.passed).toBe(true);
  });

  it('fails when the expected member is absent', async () => {
    const checks: VerifyCheck[] = [
      { type: 'team-exists', nameContains: 'Design Chapter', hasMemberUsername: 'someone-else' },
    ];
    const verdict = await runVerification(scenario(), checks, client());
    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.detail).toContain('expected "someone-else"');
  });

  it('fails when the member exists but is not an admin as required', async () => {
    const checks: VerifyCheck[] = [
      {
        type: 'team-exists',
        nameContains: 'Design Chapter',
        hasMemberUsername: 'e2e-mutable',
        memberIsAdmin: true,
      },
    ];
    const verdict = await runVerification(scenario(), checks, client());
    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.detail).toContain('admin flag is false, expected true');
  });

  it('reports "none" for a team with no members array at all', async () => {
    const c = client();
    delete (c.teams[0] as { members?: unknown }).members;
    const checks: VerifyCheck[] = [
      { type: 'team-exists', nameContains: 'Design Chapter', hasMemberUsername: 'e2e-mutable' },
    ];
    const verdict = await runVerification(scenario(), checks, c);
    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.detail).toContain('members [none]');
  });
});

describe('runVerification / team-absent', () => {
  it('passes when no team carries the old name (i.e. it really was a rename)', async () => {
    const c = new FakeRestClient();
    c.teams = [{ id: 7, name: 'battle-x-Design Chapter' }];
    const checks: VerifyCheck[] = [{ type: 'team-absent', nameContains: 'Design Guild' }];
    const verdict = await runVerification(scenario(), checks, c);
    expect(verdict.passed).toBe(true);
  });

  it('fails when the original team is still there beside a newly created one', async () => {
    const c = new FakeRestClient();
    c.teams = [
      { id: 7, name: 'battle-x-Design Guild' },
      { id: 8, name: 'battle-x-Design Chapter' },
    ];
    const checks: VerifyCheck[] = [{ type: 'team-absent', nameContains: 'Design Guild' }];
    const verdict = await runVerification(scenario(), checks, c);
    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.detail).toContain('still exists');
  });
});

describe('runVerification / overall verdict', () => {
  it('passes only when every check passes', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 1, title: 'battle-x-P' }];
    client.tasksByProject[1] = [{ id: 1, title: 't', project_id: 1 }];
    const checks: VerifyCheck[] = [
      { type: 'project-exists', titleContains: 'P' },
      { type: 'min-tasks-in-project', projectTitleContains: 'P', min: 5 }, // will fail: only 1 task
    ];
    const verdict = await runVerification(scenario(), checks, client);
    expect(verdict.passed).toBe(false);
    expect(verdict.checks[0]?.passed).toBe(true);
    expect(verdict.checks[1]?.passed).toBe(false);
  });
});
