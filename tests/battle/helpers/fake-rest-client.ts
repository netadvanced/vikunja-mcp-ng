import type {
  VikunjaBucket,
  VikunjaLabel,
  VikunjaProject,
  VikunjaProjectView,
  VikunjaRestClient,
  VikunjaShare,
  VikunjaTask,
  VikunjaTeam,
} from '../../../scripts/battle/lib/rest-client';

/**
 * Lightweight in-memory fake implementing `VikunjaRestClient`, shared by
 * verify.test.ts and cleanup.test.ts so both exercise the same fake
 * semantics against a plain object graph instead of a live server.
 */
export class FakeRestClient implements VikunjaRestClient {
  projects: VikunjaProject[] = [];
  tasksByProject: Record<number, VikunjaTask[]> = {};
  labels: VikunjaLabel[] = [];
  views: Record<number, VikunjaProjectView[]> = {};
  buckets: Record<number, VikunjaBucket[]> = {};
  shares: Record<number, VikunjaShare[]> = {};
  labelsByTask: Record<number, VikunjaLabel[]> = {};
  /** Tasks as the project's LIST view returns them: already in view order. */
  listViewTasksByProject: Record<number, VikunjaTask[]> = {};
  teams: VikunjaTeam[] = [];
  deletedTaskIds: number[] = [];
  deletedProjectIds: number[] = [];
  deletedLabelIds: number[] = [];
  deletedTeamIds: number[] = [];
  failDeleteProjectIds: Set<number> = new Set();
  failDeleteTeamIds: Set<number> = new Set();
  failCreateLabelTitles: Set<string> = new Set();
  failCreateTeamNames: Set<string> = new Set();
  createdLabels: VikunjaLabel[] = [];
  createdTeams: VikunjaTeam[] = [];
  private nextLabelId = 1000;
  private nextTeamId = 2000;

  request<T>(): Promise<T> {
    throw new Error('not used in these tests');
  }

  async requestOrEmpty<T>(path: string): Promise<T[]> {
    const match = /^\/tasks\/(\d+)\/labels$/.exec(path);
    if (match) {
      return (this.labelsByTask[Number(match[1])] ?? []) as unknown as T[];
    }
    return [];
  }

  async listProjects(): Promise<VikunjaProject[]> {
    return this.projects;
  }

  async listTasksInProject(projectId: number): Promise<VikunjaTask[]> {
    return this.tasksByProject[projectId] ?? [];
  }

  async listAllTasks(): Promise<VikunjaTask[]> {
    return Object.values(this.tasksByProject).flat();
  }

  async getTask(taskId: number): Promise<VikunjaTask> {
    for (const tasks of Object.values(this.tasksByProject)) {
      const found = tasks.find((t) => t.id === taskId);
      if (found) return found;
    }
    throw new Error(`task ${taskId} not found`);
  }

  async listLabels(): Promise<VikunjaLabel[]> {
    return this.labels;
  }

  async listViews(projectId: number): Promise<VikunjaProjectView[]> {
    return this.views[projectId] ?? [];
  }

  async listBuckets(projectId: number): Promise<VikunjaBucket[]> {
    return this.buckets[projectId] ?? [];
  }

  async listShares(projectId: number): Promise<VikunjaShare[]> {
    return this.shares[projectId] ?? [];
  }

  async listListViewTasks(projectId: number): Promise<VikunjaTask[]> {
    return this.listViewTasksByProject[projectId] ?? [];
  }

  async listTeams(): Promise<VikunjaTeam[]> {
    return this.teams;
  }

  async deleteTask(taskId: number): Promise<void> {
    this.deletedTaskIds.push(taskId);
  }

  async deleteProject(projectId: number): Promise<void> {
    if (this.failDeleteProjectIds.has(projectId)) {
      throw new Error(`simulated failure deleting project ${projectId}`);
    }
    this.deletedProjectIds.push(projectId);
  }

  async deleteLabel(labelId: number): Promise<void> {
    this.deletedLabelIds.push(labelId);
  }

  async createLabel(title: string): Promise<VikunjaLabel> {
    if (this.failCreateLabelTitles.has(title)) {
      throw new Error(`simulated failure creating label "${title}"`);
    }
    const label: VikunjaLabel = { id: this.nextLabelId++, title };
    this.createdLabels.push(label);
    this.labels.push(label);
    return label;
  }

  async deleteTeam(teamId: number): Promise<void> {
    if (this.failDeleteTeamIds.has(teamId)) {
      throw new Error(`simulated failure deleting team ${teamId}`);
    }
    this.deletedTeamIds.push(teamId);
  }

  async createTeam(name: string, isPublic?: boolean): Promise<VikunjaTeam> {
    if (this.failCreateTeamNames.has(name)) {
      throw new Error(`simulated failure creating team "${name}"`);
    }
    const team: VikunjaTeam = { id: this.nextTeamId++, name, is_public: isPublic ?? false };
    this.createdTeams.push(team);
    this.teams.push(team);
    return team;
  }
}
