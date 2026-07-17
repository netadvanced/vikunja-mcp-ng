/**
 * Type Safety Tests for Task Reminders
 * Tests that the reminder operations use proper TypeScript types
 *
 * Vikunja's API (models.TaskReminder) has no `id` field. Reminders are
 * `{ reminder, relative_period?, relative_to? }` on both write and read.
 * node-vikunja's typed model (`{ id, reminder_date }`) does not match the
 * real API and must not be trusted. See docs/VIKUNJA_API_ISSUES.md #7.
 */

import type { TaskReminder } from '../../src/types/vikunja';

describe('Task Reminders Type Safety', () => {
  describe('TaskReminder interface usage', () => {
    it('should enforce proper TaskReminder interface structure', () => {
      const validReminder: TaskReminder = {
        reminder: '2024-12-31T23:59:59Z',
      };

      expect(validReminder.reminder).toBe('2024-12-31T23:59:59Z');
      expect(validReminder.relative_period).toBeUndefined();
      expect(validReminder.relative_to).toBeUndefined();
    });

    it('should support relative reminders via relative_period/relative_to', () => {
      const relativeReminder: TaskReminder = {
        reminder: '2024-12-31T23:59:59Z',
        relative_period: -3600,
        relative_to: 'due_date',
      };

      expect(relativeReminder.relative_period).toBe(-3600);
      expect(relativeReminder.relative_to).toBe('due_date');
    });

    it('should catch type errors with invalid reminder structures', () => {
      // @ts-expect-error - Missing required property `reminder`
      const invalidReminder1: TaskReminder = {};

      // @ts-expect-error - Wrong property name: the API (and this type) use
      // `reminder`, never `reminder_date` — that's node-vikunja's drifted name.
      const invalidReminder2: TaskReminder = {
        reminder_date: '2024-12-31T23:59:59Z',
      };

      // @ts-expect-error - There is no `id` field on TaskReminder; the API
      // does not return one.
      const invalidReminder3: TaskReminder = {
        id: 123,
        reminder: '2024-12-31T23:59:59Z',
      };

      expect(typeof invalidReminder1.reminder).toBe('undefined');
      expect(typeof (invalidReminder2 as unknown as { reminder_date: string }).reminder_date).toBe(
        'string',
      );
      expect(typeof (invalidReminder3 as unknown as { id: number }).id).toBe('number');
    });

    it('should identify reminders by reminder date, not by a nonexistent id', () => {
      const mockReminders: TaskReminder[] = [
        { reminder: '2024-12-31T23:59:59Z' },
        { reminder: '2025-01-15T10:00:00Z' },
      ];

      // Simulate the fixed removeReminder lookup: match by exact `reminder`
      // date string, since the API exposes no id.
      const filteredByDate = mockReminders.filter(
        (r: TaskReminder) => r.reminder !== '2025-01-15T10:00:00Z',
      );

      // Simulate the fixed removeReminder lookup: match by zero-based
      // position in the reminders array.
      const filteredByIndex = mockReminders.filter((_r, index) => index !== 1);

      expect(filteredByDate).toHaveLength(1);
      expect(filteredByDate[0]?.reminder).toBe('2024-12-31T23:59:59Z');
      expect(filteredByIndex).toHaveLength(1);
      expect(filteredByIndex[0]?.reminder).toBe('2024-12-31T23:59:59Z');
    });
  });
});
