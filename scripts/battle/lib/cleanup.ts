/**
 * Prefix-based cleanup for battle-testing scenario data, run before AND
 * after every scenario (see docs/BATTLE-TESTING.md). Idempotent and
 * safe to run against a stack with zero matching data.
 *
 * Sweeps ONLY rows whose title starts with the given prefix (a full
 * `battle-<runid>-` run prefix, or the bare `battle-` root to catch
 * leftovers from a previous crashed run under a different run id) -- never
 * touches unrelated data such as the e2e stack's own `Inbox`/`MCP-Test`
 * fixtures from other harnesses. Covers projects, labels, AND tasks that
 * ended up in a pre-existing (non-prefixed) project -- e.g. an agent
 * bulk-creating into `Inbox` instead of the project it had just made -- via
 * a cross-project task sweep, not just tasks inside prefixed projects.
 *
 * TEAMS are swept too (by `name`, since `models.Team` has no `title`).
 * Unlike a project or a label, a team is global to the instance rather than
 * owned by a project, so nothing else would ever reclaim one: without this
 * sweep every run of a team scenario would leave a permanent `battle-*` team
 * behind on the stack.
 */

import type { VikunjaRestClient } from './rest-client';

export interface CleanupResult {
  deletedProjects: number;
  deletedTasks: number;
  deletedLabels: number;
  deletedTeams: number;
  errors: string[];
}

export async function cleanupByPrefix(client: VikunjaRestClient, prefix: string): Promise<CleanupResult> {
  const errors: string[] = [];
  let deletedProjects = 0;
  let deletedTasks = 0;
  let deletedLabels = 0;
  let deletedTeams = 0;
  const sweptProjectIds = new Set<number>();

  const projects = await client.listProjects();
  for (const project of projects) {
    if (!project.title.startsWith(prefix)) continue;
    try {
      const tasks = await client.listTasksInProject(project.id);
      for (const task of tasks) {
        try {
          await client.deleteTask(task.id);
          deletedTasks += 1;
        } catch (e) {
          errors.push(`delete task ${task.id} (project "${project.title}"): ${(e as Error).message}`);
        }
      }
      await client.deleteProject(project.id);
      deletedProjects += 1;
      sweptProjectIds.add(project.id);
    } catch (e) {
      errors.push(`delete project "${project.title}" (id ${project.id}): ${(e as Error).message}`);
    }
  }

  // Tasks whose title carries the prefix but whose containing project does
  // not (e.g. an agent bulk-created into a pre-existing project such as
  // `Inbox` instead of the project it had just made) are never reached by
  // the project sweep above -- catch those via a cross-project task listing.
  // Projects already swept are skipped: their tasks are already gone (or on
  // their way out via cascade delete), and re-deleting would just be a
  // spurious 404 in `errors`.
  const allTasks = await client.listAllTasks();
  for (const task of allTasks) {
    if (!task.title.startsWith(prefix)) continue;
    if (sweptProjectIds.has(task.project_id)) continue;
    try {
      await client.deleteTask(task.id);
      deletedTasks += 1;
    } catch (e) {
      errors.push(`delete stray task ${task.id} ("${task.title}", project id ${task.project_id}): ${(e as Error).message}`);
    }
  }

  const labels = await client.listLabels();
  for (const label of labels) {
    if (!label.title.startsWith(prefix)) continue;
    try {
      await client.deleteLabel(label.id);
      deletedLabels += 1;
    } catch (e) {
      errors.push(`delete label "${label.title}" (id ${label.id}): ${(e as Error).message}`);
    }
  }

  const teams = await client.listTeams();
  for (const team of teams) {
    if (!team.name.startsWith(prefix)) continue;
    try {
      await client.deleteTeam(team.id);
      deletedTeams += 1;
    } catch (e) {
      errors.push(`delete team "${team.name}" (id ${team.id}): ${(e as Error).message}`);
    }
  }

  return { deletedProjects, deletedTasks, deletedLabels, deletedTeams, errors };
}
