/**
 * The task-update strategy pair and the context that selects between them.
 * See ./TaskUpdateContext for the version rule and ./types for the contract.
 *
 * Only the selection surface is re-exported here. The strategies themselves
 * are reached through the context, so exporting them from the barrel would be
 * an invitation to bypass the routing decision.
 */

export {
  TaskUpdateContext,
  selectTaskUpdateStrategy,
  TASK_UPDATE_V2_MIN_VERSION,
} from './TaskUpdateContext';
export type { TaskUpdateInput, TaskUpdateStrategy, UpdateTaskArgs, VikunjaTask } from './types';
