/**
 * Coverage tests for `registerProjectTools` (the plural, multi-tool
 * registration interface in src/tools/projects/index.ts).
 *
 * Production wires up the single-tool `registerProjectsTool`, but the modular
 * multi-tool variant is exported public API (re-exported via
 * src/tools/projects.ts) and was previously untested. These tests verify each
 * of the three registered tools (`vikunja_projects_crud`,
 * `vikunja_projects_hierarchy`, `vikunja_projects_sharing`) routes its
 * subcommands to the right underlying operation and that the per-tool
 * validation guards fire before the operation is invoked.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { AuthManager } from '../../../src/auth/AuthManager';
import type { VikunjaClientFactory } from '../../../src/client/VikunjaClientFactory';
import { registerProjectTools } from '../../../src/tools/projects';
import { MCPError } from '../../../src/types';

jest.mock('../../../src/tools/projects/crud', () => ({
  listProjects: jest.fn(),
  getProject: jest.fn(),
  createProject: jest.fn(),
  updateProject: jest.fn(),
  deleteProject: jest.fn(),
  archiveProject: jest.fn(),
  unarchiveProject: jest.fn(),
}));

jest.mock('../../../src/tools/projects/hierarchy', () => ({
  getProjectChildren: jest.fn(),
  getProjectTree: jest.fn(),
  getProjectBreadcrumb: jest.fn(),
  moveProject: jest.fn(),
}));

jest.mock('../../../src/tools/projects/sharing', () => ({
  createProjectShare: jest.fn(),
  listProjectShares: jest.fn(),
  getProjectShare: jest.fn(),
  deleteProjectShare: jest.fn(),
  authProjectShare: jest.fn(),
}));

import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  archiveProject,
  unarchiveProject,
} from '../../../src/tools/projects/crud';
import {
  getProjectChildren,
  getProjectTree,
  getProjectBreadcrumb,
  moveProject,
} from '../../../src/tools/projects/hierarchy';
import {
  createProjectShare,
  listProjectShares,
  getProjectShare,
  deleteProjectShare,
  authProjectShare,
} from '../../../src/tools/projects/sharing';

type Handler = (args: Record<string, unknown>, context?: unknown) => Promise<unknown>;

const okResult = { content: [{ type: 'text' as const, text: 'ok' }] };

describe('registerProjectTools (multi-tool interface)', () => {
  let handlers: Record<string, Handler>;
  let mockAuthManager: AuthManager;
  let mockClientFactory: VikunjaClientFactory;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers = {};

    const mockServer = {
      tool: jest.fn((name: string, _desc: string, _schema: unknown, handler: Handler) => {
        handlers[name] = handler;
      }),
    };

    mockAuthManager = { isAuthenticated: jest.fn().mockReturnValue(true) } as unknown as AuthManager;
    mockClientFactory = {} as unknown as VikunjaClientFactory;

    (listProjects as jest.Mock).mockResolvedValue(okResult as never);
    (getProject as jest.Mock).mockResolvedValue(okResult as never);
    (createProject as jest.Mock).mockResolvedValue(okResult as never);
    (updateProject as jest.Mock).mockResolvedValue(okResult as never);
    (deleteProject as jest.Mock).mockResolvedValue(okResult as never);
    (archiveProject as jest.Mock).mockResolvedValue(okResult as never);
    (unarchiveProject as jest.Mock).mockResolvedValue(okResult as never);
    (getProjectChildren as jest.Mock).mockResolvedValue(okResult as never);
    (getProjectTree as jest.Mock).mockResolvedValue(okResult as never);
    (getProjectBreadcrumb as jest.Mock).mockResolvedValue(okResult as never);
    (moveProject as jest.Mock).mockResolvedValue(okResult as never);
    (createProjectShare as jest.Mock).mockResolvedValue(okResult as never);
    (listProjectShares as jest.Mock).mockResolvedValue(okResult as never);
    (getProjectShare as jest.Mock).mockResolvedValue(okResult as never);
    (deleteProjectShare as jest.Mock).mockResolvedValue(okResult as never);
    (authProjectShare as jest.Mock).mockResolvedValue(okResult as never);

    registerProjectTools(
      mockServer as never,
      mockAuthManager,
      mockClientFactory
    );
  });

  it('registers the three modular project tools', () => {
    expect(Object.keys(handlers).sort()).toEqual([
      'vikunja_projects_crud',
      'vikunja_projects_hierarchy',
      'vikunja_projects_sharing',
    ]);
  });

  describe('vikunja_projects_crud', () => {
    it('routes each subcommand to its operation on the happy path', async () => {
      await handlers['vikunja_projects_crud']({ subcommand: 'list' });
      expect(listProjects).toHaveBeenCalled();

      await handlers['vikunja_projects_crud']({ subcommand: 'get', id: 1 });
      expect(getProject).toHaveBeenCalled();

      await handlers['vikunja_projects_crud']({ subcommand: 'create', title: 'X' });
      expect(createProject).toHaveBeenCalled();

      await handlers['vikunja_projects_crud']({ subcommand: 'update', id: 1, title: 'Y' });
      expect(updateProject).toHaveBeenCalled();

      await handlers['vikunja_projects_crud']({ subcommand: 'delete', id: 1 });
      expect(deleteProject).toHaveBeenCalled();

      await handlers['vikunja_projects_crud']({ subcommand: 'archive', id: 1 });
      expect(archiveProject).toHaveBeenCalled();

      await handlers['vikunja_projects_crud']({ subcommand: 'unarchive', id: 1 });
      expect(unarchiveProject).toHaveBeenCalled();
    });

    it('enforces validation guards before invoking the operation', async () => {
      await expect(handlers['vikunja_projects_crud']({ subcommand: 'get' })).rejects.toThrow(MCPError);
      await expect(handlers['vikunja_projects_crud']({ subcommand: 'create' })).rejects.toThrow(MCPError);
      await expect(handlers['vikunja_projects_crud']({ subcommand: 'update' })).rejects.toThrow(MCPError);
      await expect(handlers['vikunja_projects_crud']({ subcommand: 'delete' })).rejects.toThrow(MCPError);
      await expect(handlers['vikunja_projects_crud']({ subcommand: 'archive' })).rejects.toThrow(MCPError);
      await expect(handlers['vikunja_projects_crud']({ subcommand: 'unarchive' })).rejects.toThrow(MCPError);
      expect(getProject).not.toHaveBeenCalled();
      expect(createProject).not.toHaveBeenCalled();
    });
  });

  describe('vikunja_projects_hierarchy', () => {
    it('routes each subcommand to its operation on the happy path', async () => {
      await handlers['vikunja_projects_hierarchy']({ subcommand: 'children', id: 1 });
      expect(getProjectChildren).toHaveBeenCalled();

      await handlers['vikunja_projects_hierarchy']({ subcommand: 'tree' });
      expect(getProjectTree).toHaveBeenCalled();

      await handlers['vikunja_projects_hierarchy']({ subcommand: 'breadcrumb', id: 1 });
      expect(getProjectBreadcrumb).toHaveBeenCalled();

      await handlers['vikunja_projects_hierarchy']({ subcommand: 'move', id: 1, parentProjectId: 2 });
      expect(moveProject).toHaveBeenCalled();
    });

    it('enforces validation guards before invoking the operation', async () => {
      await expect(handlers['vikunja_projects_hierarchy']({ subcommand: 'children' })).rejects.toThrow(MCPError);
      await expect(handlers['vikunja_projects_hierarchy']({ subcommand: 'breadcrumb' })).rejects.toThrow(MCPError);
      await expect(handlers['vikunja_projects_hierarchy']({ subcommand: 'move' })).rejects.toThrow(MCPError);
      expect(getProjectChildren).not.toHaveBeenCalled();
      expect(moveProject).not.toHaveBeenCalled();
    });
  });

  describe('vikunja_projects_sharing', () => {
    it('routes each subcommand to its operation on the happy path', async () => {
      await handlers['vikunja_projects_sharing']({ subcommand: 'create_share', projectId: 1, right: 'read' });
      expect(createProjectShare).toHaveBeenCalled();

      await handlers['vikunja_projects_sharing']({ subcommand: 'list_shares', projectId: 1 });
      expect(listProjectShares).toHaveBeenCalled();

      await handlers['vikunja_projects_sharing']({ subcommand: 'get_share', shareId: 'abc' });
      expect(getProjectShare).toHaveBeenCalled();

      await handlers['vikunja_projects_sharing']({ subcommand: 'delete_share', shareId: 'abc' });
      expect(deleteProjectShare).toHaveBeenCalled();

      await handlers['vikunja_projects_sharing']({
        subcommand: 'auth_share',
        shareHash: 'hash',
        projectId: 1,
        password: 'pw',
      });
      expect(authProjectShare).toHaveBeenCalled();
    });

    it('enforces validation guards before invoking the operation', async () => {
      await expect(
        handlers['vikunja_projects_sharing']({ subcommand: 'create_share' })
      ).rejects.toThrow(MCPError);
      await expect(
        handlers['vikunja_projects_sharing']({ subcommand: 'create_share', projectId: 1 })
      ).rejects.toThrow(MCPError);
      await expect(
        handlers['vikunja_projects_sharing']({ subcommand: 'list_shares' })
      ).rejects.toThrow(MCPError);
      await expect(
        handlers['vikunja_projects_sharing']({ subcommand: 'get_share' })
      ).rejects.toThrow(MCPError);
      await expect(
        handlers['vikunja_projects_sharing']({ subcommand: 'delete_share' })
      ).rejects.toThrow(MCPError);
      await expect(
        handlers['vikunja_projects_sharing']({ subcommand: 'auth_share' })
      ).rejects.toThrow(MCPError);
      expect(createProjectShare).not.toHaveBeenCalled();
      expect(authProjectShare).not.toHaveBeenCalled();
    });
  });
});
