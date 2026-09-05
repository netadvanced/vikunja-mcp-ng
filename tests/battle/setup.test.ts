import { runSetup } from '../../scripts/battle/lib/setup';
import { FakeRestClient } from './helpers/fake-rest-client';
import type { SetupAction } from '../../scripts/battle/types';

describe('runSetup', () => {
  it('creates a label for a create-label action and returns its id', async () => {
    const client = new FakeRestClient();
    const actions: SetupAction[] = [{ type: 'create-label', title: 'battle-run1-existing-tag' }];

    const result = await runSetup(client, actions);

    expect(result.errors).toEqual([]);
    expect(result.createdLabelIds).toHaveLength(1);
    expect(client.createdLabels).toEqual([
      { id: result.createdLabelIds[0], title: 'battle-run1-existing-tag' },
    ]);
  });

  it('runs multiple setup actions in order and collects all created label ids', async () => {
    const client = new FakeRestClient();
    const actions: SetupAction[] = [
      { type: 'create-label', title: 'battle-run1-tag-a' },
      { type: 'create-label', title: 'battle-run1-tag-b' },
    ];

    const result = await runSetup(client, actions);

    expect(result.createdLabelIds).toHaveLength(2);
    expect(client.createdLabels.map((l) => l.title)).toEqual([
      'battle-run1-tag-a',
      'battle-run1-tag-b',
    ]);
  });

  it('is a no-op (no errors, no created labels) when given an empty action list', async () => {
    const client = new FakeRestClient();

    const result = await runSetup(client, []);

    expect(result).toEqual({ createdLabelIds: [], createdTeamIds: [], errors: [] });
  });

  it('records a failed action as an error and continues with the remaining actions rather than throwing', async () => {
    const client = new FakeRestClient();
    client.failCreateLabelTitles.add('battle-run1-bad-tag');
    const actions: SetupAction[] = [
      { type: 'create-label', title: 'battle-run1-bad-tag' },
      { type: 'create-label', title: 'battle-run1-good-tag' },
    ];

    const result = await runSetup(client, actions);

    expect(result.createdLabelIds).toHaveLength(1);
    expect(client.createdLabels.map((l) => l.title)).toEqual(['battle-run1-good-tag']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('battle-run1-bad-tag');
  });

  it('creates a team for a create-team action, carrying its isPublic flag through', async () => {
    const client = new FakeRestClient();
    const actions: SetupAction[] = [
      { type: 'create-team', name: 'battle-run1-Design Guild', isPublic: true },
    ];

    const result = await runSetup(client, actions);

    expect(result.errors).toEqual([]);
    expect(result.createdTeamIds).toHaveLength(1);
    expect(client.createdTeams).toEqual([
      { id: result.createdTeamIds[0], name: 'battle-run1-Design Guild', is_public: true },
    ]);
  });

  it('defaults a create-team action with no isPublic to a non-public team', async () => {
    const client = new FakeRestClient();
    const actions: SetupAction[] = [{ type: 'create-team', name: 'battle-run1-Quiet Team' }];

    const result = await runSetup(client, actions);

    expect(result.createdTeamIds).toHaveLength(1);
    expect(client.createdTeams[0]?.is_public).toBe(false);
  });

  it('records a failed create-team as an error without aborting later actions', async () => {
    const client = new FakeRestClient();
    client.failCreateTeamNames.add('battle-run1-Bad Team');
    const actions: SetupAction[] = [
      { type: 'create-team', name: 'battle-run1-Bad Team' },
      { type: 'create-label', title: 'battle-run1-good-tag' },
    ];

    const result = await runSetup(client, actions);

    expect(result.createdTeamIds).toEqual([]);
    expect(result.createdLabelIds).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('create-team');
  });
});
