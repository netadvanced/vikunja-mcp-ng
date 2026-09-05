/**
 * The saved-filter update strategy pair and the context that selects between
 * them. See ./SavedFilterUpdateContext for the version rule and ./types for
 * the contract.
 *
 * Only the selection surface and the pure field mapping are re-exported. The
 * strategies themselves are reached through the context, so exporting them
 * from the barrel would be an invitation to bypass the routing decision.
 */

export {
  SavedFilterUpdateContext,
  selectSavedFilterUpdateStrategy,
} from './SavedFilterUpdateContext';
export { resolveSavedFilterAffectedFields } from './analysis';
export type {
  SavedFilterApi,
  SavedFilterUpdateField,
  SavedFilterUpdateFields,
  SavedFilterUpdateInput,
  SavedFilterUpdateParams,
  SavedFilterUpdateStrategy,
} from './types';
