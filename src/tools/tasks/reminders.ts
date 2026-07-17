/**
 * Reminder operations for tasks
 */

import type { TaskReminder } from '../../types';
import { MCPError, ErrorCode } from '../../types';
import { getClientFromContext } from '../../client';
import { validateId, validateDateString } from './validation';
import { formatAorpAsMarkdown, createAorpFromData } from '../../utils/response-factory';

/**
 * Add a reminder to a task
 */
export async function addReminder(args: {
  id?: number;
  reminderDate?: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    if (!args.id) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Task id is required for add-reminder operation',
      );
    }
    validateId(args.id, 'id');

    if (!args.reminderDate) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'reminderDate is required for add-reminder operation',
      );
    }
    validateDateString(args.reminderDate, 'reminderDate');

    const client = await getClientFromContext();

    // Get current task to preserve existing reminders
    const currentTask = await client.tasks.getTask(args.id);

    // Vikunja v2.3.0 stores an absolute reminder under the `reminder` key.
    // node-vikunja's typed model still calls it `reminder_date`, so sending
    // that key makes Vikunja silently store a zero (0001-01-01) reminder.
    // Read and write the actual API field; preserve any existing reminders
    // (absolute or relative) verbatim.
    const existingReminders = (
      (currentTask.reminders ?? []) as unknown as Array<{
        reminder?: string;
        relative_period?: number;
        relative_to?: string;
      }>
    ).map((r) => ({
      reminder: r.reminder,
      ...(r.relative_period !== undefined ? { relative_period: r.relative_period } : {}),
      ...(r.relative_to !== undefined ? { relative_to: r.relative_to } : {}),
    }));

    const updatedReminders = [...existingReminders, { reminder: args.reminderDate }];

    // Update task with new reminders array. node-vikunja's Task type does not
    // describe the `reminder` key, so cast through to the API body it forwards.
    await client.tasks.updateTask(args.id, {
      ...currentTask,
      reminders: updatedReminders,
    } as unknown as Parameters<typeof client.tasks.updateTask>[1]);

    // Fetch updated task
    await client.tasks.getTask(args.id);

    // Create proper AORP response
    const aorpResult = createAorpFromData(
      'add-reminder',
      `Reminder added successfully for ${args.reminderDate}`,
      true,
      `Reminder added successfully for ${args.reminderDate}`
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(aorpResult),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to add reminder: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Remove a reminder from a task.
 *
 * Vikunja's API (models.TaskReminder) has no `id` field, so reminders cannot
 * be identified the way `remove-reminder` used to (filtering by a nonexistent
 * `reminder.id`, which always threw "not found" against a real server).
 * Callers must instead identify the reminder to remove by its exact
 * `reminder` date string (as shown by `list-reminders`) and/or its
 * zero-based positional `reminderIndex` in that same listing.
 */
export async function removeReminder(args: {
  id?: number | undefined;
  reminderDate?: string | undefined;
  reminderIndex?: number | undefined;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    if (!args.id) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Task id is required for remove-reminder operation',
      );
    }
    validateId(args.id, 'id');

    const hasReminderDate = args.reminderDate !== undefined;
    const hasReminderIndex = args.reminderIndex !== undefined;

    if (!hasReminderDate && !hasReminderIndex) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Either reminderDate or reminderIndex is required for remove-reminder operation',
      );
    }

    if (hasReminderDate) {
      validateDateString(args.reminderDate as string, 'reminderDate');
    }

    if (
      hasReminderIndex &&
      (!Number.isInteger(args.reminderIndex) || (args.reminderIndex as number) < 0)
    ) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'reminderIndex must be a non-negative integer',
      );
    }

    const client = await getClientFromContext();

    // Get current task
    const currentTask = await client.tasks.getTask(args.id);

    // Vikunja stores reminders under the `reminder` key (models.TaskReminder
    // has no `id` field), the same field addReminder writes. node-vikunja's
    // typed model still calls it `reminder_date` / `id`, so read the actual
    // API shape rather than trusting the (drifted) library type.
    const existingReminders = (
      (currentTask.reminders ?? []) as unknown as TaskReminder[]
    ).map((r: TaskReminder) => ({
      reminder: r.reminder,
      ...(r.relative_period !== undefined ? { relative_period: r.relative_period } : {}),
      ...(r.relative_to !== undefined ? { relative_to: r.relative_to } : {}),
    }));

    if (existingReminders.length === 0) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task has no reminders to remove');
    }

    let targetIndex: number;

    if (hasReminderIndex) {
      targetIndex = args.reminderIndex as number;
      if (targetIndex >= existingReminders.length) {
        throw new MCPError(
          ErrorCode.VALIDATION_ERROR,
          `reminderIndex ${targetIndex} not found in task (task has ${existingReminders.length} reminder(s))`,
        );
      }
      if (hasReminderDate && existingReminders[targetIndex]?.reminder !== args.reminderDate) {
        throw new MCPError(
          ErrorCode.VALIDATION_ERROR,
          `Reminder at index ${targetIndex} does not match reminderDate ${args.reminderDate}`,
        );
      }
    } else {
      targetIndex = existingReminders.findIndex((r) => r.reminder === args.reminderDate);
      if (targetIndex === -1) {
        throw new MCPError(
          ErrorCode.VALIDATION_ERROR,
          `Reminder with date ${args.reminderDate} not found in task`,
        );
      }
    }

    const removedReminder = existingReminders[targetIndex];
    const updatedReminders = existingReminders.filter((_, i) => i !== targetIndex);

    // Update task with filtered reminders. node-vikunja's Task type does not
    // describe the `reminder` key, so cast through to the API body it forwards.
    await client.tasks.updateTask(args.id, {
      ...currentTask,
      reminders: updatedReminders,
    } as unknown as Parameters<typeof client.tasks.updateTask>[1]);

    // Fetch updated task
    await client.tasks.getTask(args.id);

    // Create proper AORP response
    const removedDescription = removedReminder?.reminder ?? `index ${targetIndex}`;
    const aorpResult = createAorpFromData(
      'remove-reminder',
      `Reminder ${removedDescription} removed successfully`,
      true,
      `Reminder ${removedDescription} removed successfully`
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(aorpResult),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to remove reminder: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * List all reminders for a task
 */
export async function listReminders(args: {
  id?: number;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    if (!args.id) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Task id is required for list-reminders operation',
      );
    }
    validateId(args.id, 'id');

    const client = await getClientFromContext();

    // Get task with reminders
    const task = await client.tasks.getTask(args.id);
    // Vikunja stores reminders under the `reminder` key (models.TaskReminder
    // has no `id` field); node-vikunja's typed model still calls it
    // `reminder_date` / `id`, so read the actual API shape. See addReminder
    // and removeReminder for the same field-name handling.
    const reminders = ((task.reminders ?? []) as unknown as TaskReminder[]).map(
      (r: TaskReminder) => ({
        reminder: r.reminder,
        ...(r.relative_period !== undefined ? { relative_period: r.relative_period } : {}),
        ...(r.relative_to !== undefined ? { relative_to: r.relative_to } : {}),
      }),
    );

    const summary = `Found ${reminders.length} reminder(s) for task "${task.title}"`;
    // Surface the identifiers (reminderIndex / reminderDate) callers need
    // to pass to remove-reminder, since the API exposes no reminder id.
    const reminderLines = reminders
      .map((r, index) => {
        const parts = [`reminder: ${r.reminder}`];
        if (r.relative_period !== undefined) {
          parts.push(`relative_period: ${r.relative_period}`);
        }
        if (r.relative_to !== undefined) {
          parts.push(`relative_to: ${r.relative_to}`);
        }
        return `- reminderIndex ${index}: ${parts.join(', ')}`;
      })
      .join('\n');
    const details = reminderLines ? `${summary}\n\n${reminderLines}` : summary;

    // Create proper AORP response
    const aorpResult = createAorpFromData('list-reminders', summary, true, details);

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(aorpResult),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to list reminders: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
