/**
 * The team-update strategy pair and the context that selects between them.
 * See ./TeamUpdateContext for the version rule and ./types for the contract.
 *
 * Only the selection surface is re-exported here. The strategies themselves are
 * reached through the context, so exporting them from the barrel would be an
 * invitation to bypass the routing decision.
 */

export { TeamUpdateContext, selectTeamUpdateStrategy } from './TeamUpdateContext';
export type { TeamUpdateArgs, TeamUpdateInput, TeamUpdateStrategy } from './types';
