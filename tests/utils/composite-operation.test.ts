import {
  CompositeOperation,
  CompositeOperationValidationError,
  type CompensationContext,
  type CompensationOutcome,
  type CompositeStep,
} from '../../src/utils/composite-operation';
import { logger } from '../../src/utils/logger';

describe('CompositeOperation', () => {
  describe('all steps succeed', () => {
    it('returns ok:true with every step marked succeeded and no guidance', async () => {
      const op = new CompositeOperation();
      op.addStep({ name: 'a', execute: () => 'A' });
      op.addStep({ name: 'b', execute: () => 'B' });

      const result = await op.run();

      expect(result.ok).toBe(true);
      expect(result.atomic).toBe(false);
      expect(result.manualFixRequired).toBe(false);
      expect(result.guidance).toBeUndefined();
      expect(result.error).toBeUndefined();
      expect(result.steps).toEqual([
        { name: 'a', status: 'succeeded', destructive: false },
        { name: 'b', status: 'succeeded', destructive: false },
      ]);
    });

    it('handles an operation with no steps registered', async () => {
      const op = new CompositeOperation();
      const result = await op.run();
      expect(result).toEqual({ ok: true, atomic: false, steps: [], manualFixRequired: false });
    });

    it('supports synchronous execute() return values', async () => {
      const op = new CompositeOperation();
      op.addStep({ name: 'sync', execute: () => 'sync-result' });
      const result = await op.run();
      expect(result.ok).toBe(true);
      expect(result.steps[0]?.status).toBe('succeeded');
    });

    it('threads prior step results into later steps via ctx.results', async () => {
      const op = new CompositeOperation();
      op.addStep({ name: 'first', execute: () => 1 });
      op.addStep({
        name: 'second',
        execute: (ctx) => {
          expect(ctx.results.get('first')).toBe(1);
          return 2;
        },
      });
      const result = await op.run();
      expect(result.ok).toBe(true);
    });
  });

  describe('best-effort mode (default)', () => {
    it('stops at the failing step and marks later steps skipped, leaving earlier successes in place', async () => {
      const op = new CompositeOperation();
      const compensateA = jest.fn();
      op.addStep({ name: 'a', execute: () => 'A' });
      op.addStep({
        name: 'b',
        execute: () => {
          throw new Error('boom');
        },
      });
      op.addStep({ name: 'c', execute: () => 'C' });

      const result = await op.run();

      expect(result.ok).toBe(false);
      expect(result.atomic).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('boom');
      expect(result.manualFixRequired).toBe(true);
      expect(result.guidance).toContain('failed at step "b"');
      expect(result.guidance).toContain('best-effort mode');
      expect(result.steps).toEqual([
        { name: 'a', status: 'succeeded', destructive: false },
        { name: 'b', status: 'failed', destructive: false, error: result.error },
        { name: 'c', status: 'skipped', destructive: false },
      ]);
      // best-effort never calls compensate at all
      expect(compensateA).not.toHaveBeenCalled();
    });

    it('does not require a manual fix when the very first step fails', async () => {
      const op = new CompositeOperation();
      op.addStep({
        name: 'a',
        execute: () => {
          throw new Error('first step boom');
        },
      });
      op.addStep({ name: 'b', execute: () => 'B' });

      const result = await op.run();

      expect(result.ok).toBe(false);
      expect(result.manualFixRequired).toBe(false);
      expect(result.guidance).toBeUndefined();
      expect(result.steps[0]?.status).toBe('failed');
      expect(result.steps[1]?.status).toBe('skipped');
    });

    it('never invokes compensate() even when steps define one', async () => {
      const op = new CompositeOperation();
      const compensate = jest.fn();
      op.addStep({ name: 'a', execute: () => 'A', compensate });
      op.addStep({
        name: 'b',
        execute: () => {
          throw new Error('boom');
        },
      });

      await op.run();

      expect(compensate).not.toHaveBeenCalled();
    });

    it('treats captureBefore() throwing the same as execute() failing', async () => {
      const op = new CompositeOperation();
      op.addStep({
        name: 'a',
        captureBefore: () => {
          throw new Error('snapshot failed');
        },
        execute: () => 'A',
      });

      const result = await op.run();

      expect(result.ok).toBe(false);
      expect(result.steps[0]?.status).toBe('failed');
      expect((result.error as Error).message).toBe('snapshot failed');
    });
  });

  describe('atomic mode', () => {
    it('compensates previously-succeeded steps in reverse order', async () => {
      const order: string[] = [];
      const op = new CompositeOperation({ atomic: true });
      op.addStep({
        name: 'create',
        execute: () => {
          order.push('execute:create');
          return { id: 1 };
        },
        compensate: () => {
          order.push('compensate:create');
        },
      });
      op.addStep({
        name: 'attach',
        execute: () => {
          order.push('execute:attach');
          return { id: 2 };
        },
        compensate: () => {
          order.push('compensate:attach');
        },
      });
      op.addStep({
        name: 'update',
        execute: () => {
          order.push('execute:update');
          throw new Error('update failed');
        },
      });

      const result = await op.run();

      expect(result.ok).toBe(false);
      expect(result.atomic).toBe(true);
      expect(order).toEqual([
        'execute:create',
        'execute:attach',
        'execute:update',
        'compensate:attach',
        'compensate:create',
      ]);
      expect(result.steps.map((s) => s.status)).toEqual(['compensated', 'compensated', 'failed']);
      expect(result.manualFixRequired).toBe(false);
    });

    it('can be enabled via the constructor default and overridden per-run', async () => {
      const compensate = jest.fn();
      const opAtomicByDefault = new CompositeOperation({ atomic: true });
      opAtomicByDefault.addStep({ name: 'a', execute: () => 'A', compensate });
      opAtomicByDefault.addStep({
        name: 'b',
        execute: () => {
          throw new Error('boom');
        },
      });

      const defaultRun = await opAtomicByDefault.run();
      expect(defaultRun.atomic).toBe(true);
      expect(compensate).toHaveBeenCalledTimes(1);

      compensate.mockClear();
      const overridden = await opAtomicByDefault.run({ atomic: false });
      expect(overridden.atomic).toBe(false);
      expect(compensate).not.toHaveBeenCalled();
    });

    it('marks compensation-failed with manual-fix guidance listing what was and was not rolled back', async () => {
      const op = new CompositeOperation({ atomic: true });
      op.addStep({
        name: 'create',
        execute: () => 'created',
        compensate: () => {
          throw new Error('undo-create exploded');
        },
      });
      op.addStep({
        name: 'attach',
        execute: () => 'attached',
        compensate: () => undefined,
      });
      op.addStep({
        name: 'update',
        execute: () => {
          throw new Error('update failed');
        },
      });

      const result = await op.run();

      expect(result.manualFixRequired).toBe(true);
      const createTrace = result.steps.find((s) => s.name === 'create');
      expect(createTrace?.status).toBe('compensation-failed');
      expect(createTrace?.compensationError).toBeInstanceOf(Error);
      expect((createTrace?.compensationError as Error).message).toBe('undo-create exploded');
      expect(createTrace?.guidance).toContain('Compensation for step "create" FAILED');
      expect(createTrace?.guidance).toContain('undo-create exploded');

      const attachTrace = result.steps.find((s) => s.name === 'attach');
      expect(attachTrace?.status).toBe('compensated');

      expect(result.guidance).toContain('rollback FAILED');
      expect(result.guidance).toContain('rolled back successfully');
      expect(result.guidance).toContain('failed with the triggering error');
    });

    it('handles a non-Error thrown by compensate(), including a value JSON.stringify cannot serialize', async () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      const op = new CompositeOperation({ atomic: true });
      op.addStep({
        name: 'a',
        execute: () => 'A',
        compensate: () => {
          throw circular;
        },
      });
      op.addStep({
        name: 'b',
        execute: () => {
          throw new Error('boom');
        },
      });

      const result = await op.run();
      const aTrace = result.steps.find((s) => s.name === 'a');
      expect(aTrace?.status).toBe('compensation-failed');
      expect(aTrace?.guidance).toContain('[object Object]');
    });

    it('handles a plain-object thrown by compensate() that JSON.stringify can serialize', async () => {
      const op = new CompositeOperation({ atomic: true });
      op.addStep({
        name: 'a',
        execute: () => 'A',
        compensate: () => {
          throw { code: 'BAD' };
        },
      });
      op.addStep({
        name: 'b',
        execute: () => {
          throw new Error('boom');
        },
      });

      const result = await op.run();
      const aTrace = result.steps.find((s) => s.name === 'a');
      expect(aTrace?.guidance).toContain('{"code":"BAD"}');
    });

    it('marks compensation-skipped-concurrent-edit and surfaces the supplied guidance', async () => {
      const op = new CompositeOperation({ atomic: true });
      op.addStep({
        name: 'update-task',
        execute: () => ({ id: 1, updated: '2026-01-01T00:00:00Z' }),
        compensate: (): CompensationOutcome => ({
          skipped: 'concurrent-edit',
          guidance: 'Task was modified by someone else after our update; leaving it alone.',
        }),
      });
      op.addStep({
        name: 'later-step',
        execute: () => {
          throw new Error('boom');
        },
      });

      const result = await op.run();
      const trace = result.steps.find((s) => s.name === 'update-task');
      expect(trace?.status).toBe('compensation-skipped-concurrent-edit');
      expect(trace?.guidance).toBe('Task was modified by someone else after our update; leaving it alone.');
      expect(result.manualFixRequired).toBe(true);
      expect(result.guidance).toContain('rollback skipped (concurrent edit detected)');
    });

    it('passes expectedUpdated derived from the execute() result to compensate()', async () => {
      let captured: CompensationContext | undefined;
      const op = new CompositeOperation({ atomic: true });
      op.addStep({
        name: 'update-task',
        execute: () => ({ id: 1, updated: '2026-05-01T12:00:00Z' }),
        compensate: (ctx) => {
          captured = ctx;
        },
      });
      op.addStep({
        name: 'later',
        execute: () => {
          throw new Error('boom');
        },
      });

      await op.run();

      expect(captured?.expectedUpdated).toBe('2026-05-01T12:00:00Z');
      expect(captured?.result).toEqual({ id: 1, updated: '2026-05-01T12:00:00Z' });
      expect(captured?.triggeringError).toBeInstanceOf(Error);
    });

    it.each([
      ['undefined result', undefined],
      ['null result', null],
      ['primitive result', 42],
      ['object without updated field', { id: 1 }],
      ['object with non-string updated field', { id: 1, updated: 12345 }],
    ])('leaves expectedUpdated undefined for %s', async (_label, executeResult) => {
      let captured: CompensationContext | undefined;
      const op = new CompositeOperation({ atomic: true });
      op.addStep({
        name: 'step',
        execute: () => executeResult,
        compensate: (ctx) => {
          captured = ctx;
        },
      });
      op.addStep({
        name: 'later',
        execute: () => {
          throw new Error('boom');
        },
      });

      await op.run();

      expect(captured?.expectedUpdated).toBeUndefined();
    });

    it('threads the captureBefore() snapshot into compensate() as `before`', async () => {
      let captured: CompensationContext | undefined;
      const op = new CompositeOperation({ atomic: true });
      op.addStep({
        name: 'update-task',
        captureBefore: () => ({ id: 1, title: 'Original title', updated: '2026-01-01T00:00:00Z' }),
        execute: () => ({ id: 1, title: 'New title', updated: '2026-01-02T00:00:00Z' }),
        compensate: (ctx) => {
          captured = ctx;
        },
      });
      op.addStep({
        name: 'later',
        execute: () => {
          throw new Error('boom');
        },
      });

      await op.run();

      expect(captured?.before).toEqual({ id: 1, title: 'Original title', updated: '2026-01-01T00:00:00Z' });
    });

    it('marks a succeeded destructive step with no compensate() as needing manual verification (no undelete)', async () => {
      const op = new CompositeOperation({ atomic: true });
      op.addStep({ name: 'delete-old', destructive: true, execute: () => 'deleted' });
      op.addStep({
        name: 'next',
        execute: () => {
          throw new Error('boom');
        },
      });

      const result = await op.run();
      const trace = result.steps.find((s) => s.name === 'delete-old');
      expect(trace?.status).toBe('succeeded');
      expect(trace?.guidance).toContain('Vikunja has no undelete');
      expect(result.manualFixRequired).toBe(true);
      expect(result.guidance).toContain('NOT rolled back');
    });

    it('marks a succeeded non-destructive step with no compensate() as needing manual verification', async () => {
      const op = new CompositeOperation({ atomic: true });
      op.addStep({ name: 'notify', execute: () => 'notified' });
      op.addStep({
        name: 'next',
        execute: () => {
          throw new Error('boom');
        },
      });

      const result = await op.run();
      const trace = result.steps.find((s) => s.name === 'notify');
      expect(trace?.status).toBe('succeeded');
      expect(trace?.guidance).toContain('defines no compensate()');
      expect(result.manualFixRequired).toBe(true);
    });
  });

  describe('addStep validation', () => {
    it('rejects duplicate step names', () => {
      const op = new CompositeOperation();
      op.addStep({ name: 'dup', execute: () => 1 });
      expect(() => op.addStep({ name: 'dup', execute: () => 2 })).toThrow(CompositeOperationValidationError);
      expect(() => op.addStep({ name: 'dup', execute: () => 2 })).toThrow(/Duplicate step name/);
    });

    it('rejects a compensatable step registered after a destructive step by default', () => {
      const op = new CompositeOperation();
      op.addStep({ name: 'delete-it', destructive: true, execute: () => 1 });
      expect(() => op.addStep({ name: 'after', execute: () => 2, compensate: () => undefined })).toThrow(
        CompositeOperationValidationError,
      );
      expect(() => op.addStep({ name: 'after2', execute: () => 2, compensate: () => undefined })).toThrow(
        /must be sequenced last/,
      );
    });

    it('allows a non-compensatable step registered after a destructive step', () => {
      const op = new CompositeOperation();
      op.addStep({ name: 'delete-it', destructive: true, execute: () => 1 });
      expect(() => op.addStep({ name: 'after', execute: () => 2 })).not.toThrow();
    });

    it('allows the destructive step itself to define compensate()', () => {
      const op = new CompositeOperation();
      expect(() =>
        op.addStep({ name: 'delete-it', destructive: true, execute: () => 1, compensate: () => undefined }),
      ).not.toThrow();
    });

    it('flags a second destructive step that itself defines compensate() as registered after the first', () => {
      const op = new CompositeOperation();
      op.addStep({ name: 'delete-1', destructive: true, execute: () => 1 });
      expect(() =>
        op.addStep({
          name: 'delete-2',
          destructive: true,
          execute: () => 2,
          compensate: () => undefined,
        }),
      ).toThrow(CompositeOperationValidationError);
    });

    it('warns instead of throwing when destructiveOrderPolicy is "warn"', () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const op = new CompositeOperation({ destructiveOrderPolicy: 'warn' });
        op.addStep({ name: 'delete-it', destructive: true, execute: () => 1 });
        expect(() =>
          op.addStep({ name: 'after', execute: () => 2, compensate: () => undefined }),
        ).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('must be sequenced last'));
        expect(op.getSteps()).toHaveLength(2);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('addStep returns `this` for chaining and getSteps() reflects registration order', () => {
      const op = new CompositeOperation();
      const returned = op.addStep({ name: 'a', execute: () => 1 }).addStep({ name: 'b', execute: () => 2 });
      expect(returned).toBe(op);
      expect(op.getSteps().map((s) => s.name)).toEqual(['a', 'b']);
    });
  });

  describe('integration: 3-step composite (create -> attach -> update) with mid-flight failure', () => {
    interface FakeTask {
      id: number;
      title: string;
      updated: string;
    }

    function makeMockVikunjaClient() {
      const tasksById = new Map<number, FakeTask>();
      const attachmentsByTaskId = new Map<number, number[]>();
      let nextTaskId = 1;
      let nextAttachmentId = 1;

      return {
        createTask: jest.fn((title: string): Promise<FakeTask> => {
          const task: FakeTask = { id: nextTaskId++, title, updated: '2026-01-01T00:00:00Z' };
          tasksById.set(task.id, task);
          return Promise.resolve(task);
        }),
        deleteTask: jest.fn((id: number): Promise<void> => {
          tasksById.delete(id);
          return Promise.resolve();
        }),
        attachFile: jest.fn((taskId: number): Promise<{ attachmentId: number }> => {
          const attachmentId = nextAttachmentId++;
          const list = attachmentsByTaskId.get(taskId) ?? [];
          list.push(attachmentId);
          attachmentsByTaskId.set(taskId, list);
          return Promise.resolve({ attachmentId });
        }),
        removeAttachment: jest.fn((taskId: number, attachmentId: number): Promise<void> => {
          const list = attachmentsByTaskId.get(taskId) ?? [];
          attachmentsByTaskId.set(
            taskId,
            list.filter((id) => id !== attachmentId),
          );
          return Promise.resolve();
        }),
        updateTask: jest.fn((): Promise<FakeTask> => {
          throw new Error('simulated mid-flight update failure (e.g. network timeout)');
        }),
        _tasksById: tasksById,
        _attachmentsByTaskId: attachmentsByTaskId,
      };
    }

    it('rolls back the attachment and the created task, in reverse order, when the update step fails', async () => {
      const client = makeMockVikunjaClient();
      const op = new CompositeOperation({ atomic: true });

      let lastCreatedTaskId = -1;

      const createStep: CompositeStep<FakeTask> = {
        name: 'create-task',
        execute: async () => {
          const task = await client.createTask('Composite saga test task');
          lastCreatedTaskId = task.id;
          return task;
        },
        compensate: async (ctx) => {
          await client.deleteTask((ctx.result as FakeTask).id);
        },
      };

      const attachStep: CompositeStep<{ attachmentId: number }> = {
        name: 'attach-file',
        execute: async (ctx) => {
          const task = ctx.results.get('create-task') as FakeTask;
          return client.attachFile(task.id);
        },
        compensate: async (ctx) => {
          const attachmentId = (ctx.result as { attachmentId: number }).attachmentId;
          await client.removeAttachment(lastCreatedTaskId, attachmentId);
        },
      };

      const updateStep: CompositeStep<FakeTask> = {
        name: 'update-task',
        execute: () => client.updateTask(),
      };

      op.addStep(createStep);
      op.addStep(attachStep);
      op.addStep(updateStep);

      const result = await op.run();

      expect(result.ok).toBe(false);
      expect(result.atomic).toBe(true);
      expect(result.steps.map((s) => ({ name: s.name, status: s.status }))).toEqual([
        { name: 'create-task', status: 'compensated' },
        { name: 'attach-file', status: 'compensated' },
        { name: 'update-task', status: 'failed' },
      ]);
      expect(result.manualFixRequired).toBe(false);

      // Compensations actually ran, and in reverse order: attachment removed before task deleted.
      expect(client.removeAttachment).toHaveBeenCalledTimes(1);
      expect(client.deleteTask).toHaveBeenCalledTimes(1);
      expect(client._tasksById.size).toBe(0);
      expect(client._attachmentsByTaskId.get(lastCreatedTaskId)).toEqual([]);

      const removeOrder = client.removeAttachment.mock.invocationCallOrder[0];
      const deleteOrder = client.deleteTask.mock.invocationCallOrder[0];
      expect(removeOrder).toBeLessThan(deleteOrder as number);
    });

    it('leaves the created task and attachment in place under best-effort (default) mode', async () => {
      const client = makeMockVikunjaClient();
      const op = new CompositeOperation();

      op.addStep({
        name: 'create-task',
        execute: () => client.createTask('Composite saga test task (best-effort)'),
        compensate: async (ctx) => {
          await client.deleteTask((ctx.result as FakeTask).id);
        },
      });
      op.addStep({
        name: 'attach-file',
        execute: (ctx) => {
          const task = ctx.results.get('create-task') as FakeTask;
          return client.attachFile(task.id);
        },
      });
      op.addStep({
        name: 'update-task',
        execute: () => client.updateTask(),
      });

      const result = await op.run();

      expect(result.ok).toBe(false);
      expect(result.atomic).toBe(false);
      expect(result.manualFixRequired).toBe(true);
      expect(client.deleteTask).not.toHaveBeenCalled();
      expect(client._tasksById.size).toBe(1);
    });
  });
});
