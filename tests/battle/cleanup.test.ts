import { cleanupByPrefix } from '../../scripts/battle/lib/cleanup';
import { FakeRestClient } from './helpers/fake-rest-client';

describe('cleanupByPrefix', () => {
  it('only touches projects/labels whose title starts with the given prefix', async () => {
    const client = new FakeRestClient();
    client.projects = [
      { id: 1, title: 'battle-run1-Foo' },
      { id: 2, title: 'Inbox' },
      { id: 3, title: 'MCP-Test' },
    ];
    client.tasksByProject[1] = [{ id: 10, title: 'battle-run1-task', project_id: 1 }];
    client.labels = [
      { id: 5, title: 'battle-run1-urgent' },
      { id: 6, title: 'someone-elses-label' },
    ];

    const result = await cleanupByPrefix(client, 'battle-run1-');

    expect(result.deletedProjects).toBe(1);
    expect(result.deletedLabels).toBe(1);
    expect(result.errors).toEqual([]);
    expect(client.deletedProjectIds).toEqual([1]);
    expect(client.deletedTaskIds).toEqual([10]);
    expect(client.deletedLabelIds).toEqual([5]);
  });

  it('deletes every task in a matched project before deleting the project itself', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 1, title: 'battle-run1-Foo' }];
    client.tasksByProject[1] = [
      { id: 10, title: 't1', project_id: 1 },
      { id: 11, title: 't2', project_id: 1 },
    ];

    await cleanupByPrefix(client, 'battle-run1-');

    expect(client.deletedTaskIds.sort()).toEqual([10, 11]);
    expect(client.deletedProjectIds).toEqual([1]);
  });

  it('is a no-op (zero deletions, zero errors) when nothing matches the prefix', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 1, title: 'Inbox' }];
    client.labels = [{ id: 2, title: 'unrelated' }];

    const result = await cleanupByPrefix(client, 'battle-run1-');

    expect(result).toEqual({
      deletedProjects: 0,
      deletedTasks: 0,
      deletedLabels: 0,
      deletedTeams: 0,
      errors: [],
    });
  });

  it('deletes a prefixed task that was created into a pre-existing (non-prefixed) project', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 2, title: 'Inbox' }];
    client.tasksByProject[2] = [
      { id: 20, title: 'battle-run1-stray', project_id: 2 },
      { id: 21, title: 'someone-elses-task', project_id: 2 },
    ];

    const result = await cleanupByPrefix(client, 'battle-run1-');

    expect(result.deletedTasks).toBe(1);
    expect(result.deletedProjects).toBe(0);
    expect(result.errors).toEqual([]);
    expect(client.deletedTaskIds).toEqual([20]);
    // The non-matching task in the same pre-existing project is untouched.
    expect(client.deletedTaskIds).not.toContain(21);
    // Inbox itself is never a candidate for deletion -- only its stray task is.
    expect(client.deletedProjectIds).toEqual([]);
  });

  it('does not re-touch tasks already deleted via a matched project sweep', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 1, title: 'battle-run1-Foo' }];
    client.tasksByProject[1] = [{ id: 10, title: 'battle-run1-task', project_id: 1 }];

    const result = await cleanupByPrefix(client, 'battle-run1-');

    expect(result.deletedTasks).toBe(1);
    expect(client.deletedTaskIds).toEqual([10]);
  });

  it('leaves non-matching titles provably untouched across projects, tasks, and labels', async () => {
    const client = new FakeRestClient();
    client.projects = [
      { id: 1, title: 'battle-run1-Foo' },
      { id: 2, title: 'Inbox' },
      { id: 3, title: 'MCP-Test' },
    ];
    client.tasksByProject = {
      1: [{ id: 10, title: 'battle-run1-task', project_id: 1 }],
      2: [{ id: 20, title: 'battle-run1-stray', project_id: 2 }],
      3: [{ id: 30, title: 'fixture-task', project_id: 3 }],
    };
    client.labels = [
      { id: 5, title: 'battle-run1-urgent' },
      { id: 6, title: 'someone-elses-label' },
    ];

    await cleanupByPrefix(client, 'battle-run1-');

    expect(client.deletedTaskIds.sort()).toEqual([10, 20]);
    expect(client.deletedProjectIds).toEqual([1]);
    expect(client.deletedLabelIds).toEqual([5]);
    // Project 3's task and its own project, and the unrelated label, all
    // provably survive the sweep.
    expect(client.deletedProjectIds).not.toContain(3);
    expect(client.deletedTaskIds).not.toContain(30);
    expect(client.deletedLabelIds).not.toContain(6);
  });

  it('running cleanup twice in a row is idempotent and stays error-free', async () => {
    const client = new FakeRestClient();
    client.projects = [{ id: 2, title: 'Inbox' }];
    client.tasksByProject[2] = [{ id: 20, title: 'battle-run1-stray', project_id: 2 }];

    const first = await cleanupByPrefix(client, 'battle-run1-');
    expect(first.deletedTasks).toBe(1);
    expect(first.errors).toEqual([]);

    // The fake client doesn't mutate its own listing on delete, but a real
    // server would no longer return the deleted task -- simulate that here.
    client.tasksByProject[2] = [];

    const second = await cleanupByPrefix(client, 'battle-run1-');
    expect(second).toEqual({
      deletedProjects: 0,
      deletedTasks: 0,
      deletedLabels: 0,
      deletedTeams: 0,
      errors: [],
    });
  });

  it('records a project-deletion failure as an error and continues the sweep rather than throwing', async () => {
    const client = new FakeRestClient();
    client.projects = [
      { id: 1, title: 'battle-run1-Bad' },
      { id: 2, title: 'battle-run1-Good' },
    ];
    client.tasksByProject[1] = [];
    client.tasksByProject[2] = [];
    client.failDeleteProjectIds.add(1);

    const result = await cleanupByPrefix(client, 'battle-run1-');

    expect(result.deletedProjects).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('battle-run1-Bad');
    expect(client.deletedProjectIds).toEqual([2]);
  });

  it("deletes only prefixed teams and leaves the instance's own teams alone", async () => {
    const client = new FakeRestClient();
    client.teams = [
      { id: 7, name: 'battle-run1-Design Guild' },
      { id: 8, name: 'battle-run2-Other Guild' },
      { id: 9, name: 'Engineering' },
    ];

    const result = await cleanupByPrefix(client, 'battle-run1-');

    expect(result.deletedTeams).toBe(1);
    expect(client.deletedTeamIds).toEqual([7]);
  });

  it('records a failed team delete as an error rather than throwing', async () => {
    const client = new FakeRestClient();
    client.teams = [
      { id: 7, name: 'battle-run1-Bad Team' },
      { id: 8, name: 'battle-run1-Good Team' },
    ];
    client.failDeleteTeamIds.add(7);

    const result = await cleanupByPrefix(client, 'battle-run1-');

    expect(result.deletedTeams).toBe(1);
    expect(client.deletedTeamIds).toEqual([8]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('battle-run1-Bad Team');
  });

  it('sweeps by the bare "battle-" root prefix across multiple distinct run ids', async () => {
    const client = new FakeRestClient();
    client.projects = [
      { id: 1, title: 'battle-run1-Foo' },
      { id: 2, title: 'battle-run2-Bar' },
      { id: 3, title: 'Inbox' },
    ];
    client.tasksByProject = { 1: [], 2: [] };

    const result = await cleanupByPrefix(client, 'battle-');

    expect(result.deletedProjects).toBe(2);
    expect(client.deletedProjectIds.sort()).toEqual([1, 2]);
  });
});
