/**
 * TaskFilteringOrchestrator behaviour coverage.
 *
 * The orchestrator is the seam between validation (FilterValidator) and
 * execution (FilterExecutor); both are mocked here so the tests pin the
 * orchestration contract itself — which errors propagate as MCPError, which
 * are wrapped, and what the reporting helpers derive from a result.
 *
 * (`tests/tools/tasks-filtering-orchestrator.test.ts` covers the storage
 * parameter's type-safety; this file covers the runtime paths.)
 */

import type { SimpleFilterStorage } from '../../../../src/storage';
import type {
  TaskFilterExecutionResult,
  TaskListingArgs,
} from '../../../../src/tools/tasks/types/filters';
import { MCPError, ErrorCode } from '../../../../src/types';

jest.mock('../../../../src/utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../../src/tools/tasks/filtering/FilterValidator', () => ({
  FilterValidator: {
    validateTaskFiltering: jest.fn(),
    validateLoadedTasks: jest.fn(),
  },
}));

jest.mock('../../../../src/tools/tasks/filtering/FilterExecutor', () => ({
  FilterExecutor: {
    prepareQueryParameters: jest.fn(),
    executeFiltering: jest.fn(),
  },
}));

import { TaskFilteringOrchestrator } from '../../../../src/tools/tasks/filtering/TaskFilteringOrchestrator';
import { FilterValidator } from '../../../../src/tools/tasks/filtering/FilterValidator';
import { FilterExecutor } from '../../../../src/tools/tasks/filtering/FilterExecutor';
import { logger } from '../../../../src/utils/logger';

const mockValidator = FilterValidator as jest.Mocked<typeof FilterValidator>;
const mockExecutor = FilterExecutor as jest.Mocked<typeof FilterExecutor>;

const storage = {} as SimpleFilterStorage;

const validationResult = (overrides: Record<string, unknown> = {}) => ({
  filterExpression: null,
  filterString: undefined,
  validationWarnings: [],
  memoryValidation: { isValid: true, warnings: [] },
  ...overrides,
});

const executionResult = (
  overrides: Partial<TaskFilterExecutionResult> = {},
): TaskFilterExecutionResult => ({
  success: true,
  tasks: [],
  metadata: {
    serverSideFilteringUsed: false,
    serverSideFilteringAttempted: false,
    clientSideFiltering: false,
    filteringNote: '',
  },
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockValidator.validateTaskFiltering.mockResolvedValue(validationResult() as never);
  mockValidator.validateLoadedTasks.mockReturnValue({ warnings: [], shouldThrow: false } as never);
  mockExecutor.prepareQueryParameters.mockReturnValue({} as never);
  mockExecutor.executeFiltering.mockResolvedValue(executionResult() as never);
});

describe('executeTaskFiltering', () => {
  it('runs validate → prepare → execute → post-validate and returns the execution result', async () => {
    const tasks = [{ id: 1 }, { id: 2 }];
    mockExecutor.executeFiltering.mockResolvedValue(
      executionResult({ tasks: tasks as never }) as never,
    );

    const args: TaskListingArgs = { projectId: 3, page: 1, perPage: 50 };
    const result = await TaskFilteringOrchestrator.executeTaskFiltering(args, storage);

    expect(result.tasks).toHaveLength(2);
    expect(mockValidator.validateTaskFiltering).toHaveBeenCalledWith(args, storage, {});
    expect(mockExecutor.prepareQueryParameters).toHaveBeenCalledWith(args);
    expect(mockValidator.validateLoadedTasks).toHaveBeenCalledWith(2);
  });

  it('threads the parsed filter, params, storage and auth manager into the executor', async () => {
    const expression = { groups: [] };
    const params = { page: 2 };
    const authManager = { getAuthType: jest.fn() };
    mockValidator.validateTaskFiltering.mockResolvedValue(
      validationResult({ filterExpression: expression, filterString: 'done = false' }) as never,
    );
    mockExecutor.prepareQueryParameters.mockReturnValue(params as never);

    const args: TaskListingArgs = { filter: 'done = false' };
    await TaskFilteringOrchestrator.executeTaskFiltering(args, storage, {}, authManager as never);

    expect(mockExecutor.executeFiltering).toHaveBeenCalledWith(
      args,
      expression,
      'done = false',
      params,
      storage,
      authManager,
    );
  });

  it('passes the caller-supplied validation config through', async () => {
    const config = { maxTaskCount: 10 };
    await TaskFilteringOrchestrator.executeTaskFiltering({}, storage, config);
    expect(mockValidator.validateTaskFiltering).toHaveBeenCalledWith({}, storage, config);
  });

  it('logs validation warnings without failing the call', async () => {
    mockValidator.validateTaskFiltering.mockResolvedValue(
      validationResult({ validationWarnings: ['large page size'] }) as never,
    );

    await expect(TaskFilteringOrchestrator.executeTaskFiltering({}, storage)).resolves.toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith('Task filtering validation warnings', {
      warnings: ['large page size'],
    });
  });

  it('logs result warnings that do not demand a throw', async () => {
    mockValidator.validateLoadedTasks.mockReturnValue({
      warnings: ['approaching memory limit'],
      shouldThrow: false,
    } as never);

    await expect(TaskFilteringOrchestrator.executeTaskFiltering({}, storage)).resolves.toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith('Task filtering result warnings', {
      warnings: ['approaching memory limit'],
    });
  });

  it('throws an INTERNAL_ERROR when post-execution validation demands it', async () => {
    mockValidator.validateLoadedTasks.mockReturnValue({
      warnings: ['too many tasks loaded', 'memory exceeded'],
      shouldThrow: true,
    } as never);

    await expect(TaskFilteringOrchestrator.executeTaskFiltering({}, storage)).rejects.toThrow(
      'Task filtering result validation failed: too many tasks loaded, memory exceeded',
    );
    await expect(TaskFilteringOrchestrator.executeTaskFiltering({}, storage)).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });
  });

  it('re-throws an MCPError from validation unchanged and without logging it as a crash', async () => {
    const mcpError = new MCPError(ErrorCode.VALIDATION_ERROR, 'Invalid filter syntax');
    mockValidator.validateTaskFiltering.mockRejectedValue(mcpError);

    await expect(TaskFilteringOrchestrator.executeTaskFiltering({}, storage)).rejects.toBe(mcpError);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs and re-throws a non-MCPError from the executor', async () => {
    const failure = new Error('network down');
    mockExecutor.executeFiltering.mockRejectedValue(failure);

    await expect(
      TaskFilteringOrchestrator.executeTaskFiltering({ filter: 'done = false', projectId: 9 }, storage),
    ).rejects.toBe(failure);
    expect(logger.error).toHaveBeenCalledWith('Task filtering orchestration failed', {
      error: 'network down',
      args: { hasFilter: true, hasFilterId: false, projectId: 9 },
    });
  });

  it('stringifies a non-Error rejection for the log', async () => {
    mockExecutor.executeFiltering.mockRejectedValue('boom');

    await expect(TaskFilteringOrchestrator.executeTaskFiltering({}, storage)).rejects.toBe('boom');
    expect(logger.error).toHaveBeenCalledWith(
      'Task filtering orchestration failed',
      expect.objectContaining({ error: 'boom' }),
    );
  });
});

describe('validateTaskFiltering', () => {
  it('reports valid input with the validator warnings and memory verdict', async () => {
    mockValidator.validateTaskFiltering.mockResolvedValue(
      validationResult({
        validationWarnings: ['heads up'],
        memoryValidation: { isValid: true, warnings: [], maxAllowed: 500 },
      }) as never,
    );

    await expect(TaskFilteringOrchestrator.validateTaskFiltering({}, storage)).resolves.toEqual({
      isValid: true,
      warnings: ['heads up'],
      errors: [],
      memoryValidation: { isValid: true, warnings: [], maxAllowed: 500 },
    });
  });

  it('surfaces an MCPError as a plain validation error rather than throwing', async () => {
    mockValidator.validateTaskFiltering.mockRejectedValue(
      new MCPError(ErrorCode.VALIDATION_ERROR, 'Invalid task listing arguments: page must be >= 1'),
    );

    await expect(TaskFilteringOrchestrator.validateTaskFiltering({}, storage)).resolves.toEqual({
      isValid: false,
      warnings: [],
      errors: ['Invalid task listing arguments: page must be >= 1'],
      memoryValidation: { isValid: false, warnings: [] },
    });
  });

  it('wraps an unexpected Error with a Validation failed prefix', async () => {
    mockValidator.validateTaskFiltering.mockRejectedValue(new Error('storage unreachable'));

    await expect(TaskFilteringOrchestrator.validateTaskFiltering({}, storage)).resolves.toEqual({
      isValid: false,
      warnings: [],
      errors: ['Validation failed: storage unreachable'],
      memoryValidation: { isValid: false, warnings: [] },
    });
  });

  it('wraps a non-Error rejection', async () => {
    mockValidator.validateTaskFiltering.mockRejectedValue('unexpected');

    const result = await TaskFilteringOrchestrator.validateTaskFiltering({}, storage);
    expect(result.errors).toEqual(['Validation failed: unexpected']);
  });

  it('forwards the config to the validator', async () => {
    await TaskFilteringOrchestrator.validateTaskFiltering({ page: 1 }, storage, { maxTaskCount: 5 });
    expect(mockValidator.validateTaskFiltering).toHaveBeenCalledWith({ page: 1 }, storage, {
      maxTaskCount: 5,
    });
  });
});

describe('createFilteringContext', () => {
  it('includes every optional input field that was supplied', () => {
    const args: TaskListingArgs = {
      filter: 'done = false',
      filterId: 'saved-1',
      projectId: 4,
      page: 2,
      perPage: 25,
      search: 'report',
      sort: 'due_date',
    };

    const context = TaskFilteringOrchestrator.createFilteringContext(args, executionResult());

    expect(context.input).toEqual({
      hasFilter: true,
      hasFilterId: true,
      projectId: 4,
      page: 2,
      perPage: 25,
      search: 'report',
      sort: 'due_date',
    });
  });

  it('omits undefined optional fields entirely (exactOptionalPropertyTypes contract)', () => {
    const context = TaskFilteringOrchestrator.createFilteringContext({}, executionResult());

    expect(context.input).toEqual({ hasFilter: false, hasFilterId: false });
    expect(Object.keys(context.input)).not.toContain('projectId');
    expect(Object.keys(context.input)).not.toContain('page');
  });

  it('mirrors the execution metadata into the output block', () => {
    const result = executionResult({
      tasks: [{ id: 1 }, { id: 2 }, { id: 3 }] as never,
      metadata: {
        serverSideFilteringUsed: true,
        serverSideFilteringAttempted: true,
        clientSideFiltering: false,
        filteringNote: 'server-side',
      },
      memoryInfo: { actualCount: 3, maxAllowed: 100, estimatedMemoryMB: 0.5 },
    });

    const context = TaskFilteringOrchestrator.createFilteringContext({}, result);

    expect(context.output).toEqual({
      taskCount: 3,
      serverSideFilteringUsed: true,
      serverSideFilteringAttempted: true,
      clientSideFiltering: false,
      filteringNote: 'server-side',
      memoryInfo: { actualCount: 3, maxAllowed: 100, estimatedMemoryMB: 0.5 },
    });
  });

  it('defaults the output block when tasks/metadata/memoryInfo are absent', () => {
    const context = TaskFilteringOrchestrator.createFilteringContext(
      {},
      {} as TaskFilterExecutionResult,
    );

    expect(context.output).toEqual({
      taskCount: 0,
      serverSideFilteringUsed: false,
      serverSideFilteringAttempted: false,
      clientSideFiltering: false,
      filteringNote: '',
    });
    expect(context.output.memoryInfo).toBeUndefined();
  });

  it('stamps an ISO timestamp', () => {
    const context = TaskFilteringOrchestrator.createFilteringContext({}, executionResult());
    expect(context.performance.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('analyzeFilteringPerformance', () => {
  it('calls a plain server-side-filtered listing optimal', () => {
    const analysis = TaskFilteringOrchestrator.analyzeFilteringPerformance(
      { filter: 'done = false', perPage: 50 },
      executionResult({
        metadata: {
          serverSideFilteringUsed: true,
          serverSideFilteringAttempted: true,
          clientSideFiltering: false,
          filteringNote: '',
        },
      }),
    );

    expect(analysis).toEqual({ isOptimal: true, recommendations: [], issues: [] });
  });

  it('flags a server-side attempt that fell back to client-side as an issue', () => {
    const analysis = TaskFilteringOrchestrator.analyzeFilteringPerformance(
      { filter: 'done = false' },
      executionResult({
        metadata: {
          serverSideFilteringUsed: false,
          serverSideFilteringAttempted: true,
          clientSideFiltering: true,
          filteringNote: '',
        },
      }),
    );

    expect(analysis.isOptimal).toBe(false);
    expect(analysis.issues).toContain(
      'Server-side filtering was attempted but failed, falling back to client-side',
    );
    expect(analysis.recommendations).toContain(
      'Consider simplifying the filter syntax for better server-side compatibility',
    );
  });

  it('recommends server-side filtering when it was never attempted', () => {
    const analysis = TaskFilteringOrchestrator.analyzeFilteringPerformance(
      { filter: 'done = false' },
      executionResult(),
    );

    expect(analysis.isOptimal).toBe(false);
    expect(analysis.issues).toEqual([]);
    expect(analysis.recommendations).toContain(
      'Consider enabling server-side filtering for better performance with large datasets',
    );
  });

  it('ignores the server-side check entirely when no filter was requested', () => {
    const analysis = TaskFilteringOrchestrator.analyzeFilteringPerformance({}, executionResult());
    expect(analysis).toEqual({ isOptimal: true, recommendations: [], issues: [] });
  });

  it('flags an oversized page but accepts the 500 boundary', () => {
    const oversized = TaskFilteringOrchestrator.analyzeFilteringPerformance(
      { perPage: 501 },
      executionResult(),
    );
    expect(oversized.isOptimal).toBe(false);
    expect(oversized.issues).toContain('Large page size may impact performance');

    const atBoundary = TaskFilteringOrchestrator.analyzeFilteringPerformance(
      { perPage: 500 },
      executionResult(),
    );
    expect(atBoundary.isOptimal).toBe(true);
  });

  it('flags a task count over the memory ceiling', () => {
    const analysis = TaskFilteringOrchestrator.analyzeFilteringPerformance(
      {},
      executionResult({ memoryInfo: { actualCount: 900, maxAllowed: 500, estimatedMemoryMB: 40 } }),
    );

    expect(analysis.isOptimal).toBe(false);
    expect(analysis.issues).toContain('Task count exceeds recommended memory limits');
    expect(analysis.recommendations).toContain(
      'Apply more specific filters or use pagination to reduce memory usage',
    );
  });

  it('accepts a task count within the memory ceiling', () => {
    const analysis = TaskFilteringOrchestrator.analyzeFilteringPerformance(
      {},
      executionResult({ memoryInfo: { actualCount: 100, maxAllowed: 500, estimatedMemoryMB: 5 } }),
    );
    expect(analysis.isOptimal).toBe(true);
  });

  it('advises on short search terms without calling the run sub-optimal', () => {
    const analysis = TaskFilteringOrchestrator.analyzeFilteringPerformance(
      { search: 'ab' },
      executionResult(),
    );

    expect(analysis.isOptimal).toBe(true);
    expect(analysis.recommendations).toContain(
      'Search terms should be at least 3 characters for better results',
    );
  });

  it('says nothing about a search term of three characters or more', () => {
    const analysis = TaskFilteringOrchestrator.analyzeFilteringPerformance(
      { search: 'abc' },
      executionResult(),
    );
    expect(analysis.recommendations).toEqual([]);
  });

  it('accumulates every issue when several apply at once', () => {
    const analysis = TaskFilteringOrchestrator.analyzeFilteringPerformance(
      { filter: 'done = false', perPage: 2000, search: 'a' },
      executionResult({
        metadata: {
          serverSideFilteringUsed: false,
          serverSideFilteringAttempted: true,
          clientSideFiltering: true,
          filteringNote: '',
        },
        memoryInfo: { actualCount: 5000, maxAllowed: 500, estimatedMemoryMB: 200 },
      }),
    );

    expect(analysis.isOptimal).toBe(false);
    expect(analysis.issues).toHaveLength(3);
    expect(analysis.recommendations).toHaveLength(4);
  });
});
