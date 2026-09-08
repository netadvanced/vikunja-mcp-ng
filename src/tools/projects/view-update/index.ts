/**
 * The project-view update strategy pair and the context that selects between
 * them. See ./ViewUpdateContext for the version rule, ./types for the
 * contract, and ./mapping for the field translation both strategies share.
 *
 * Only the selection surface and the shared mapping are re-exported here. The
 * strategies themselves are reached through the context, so exporting them
 * from the barrel would be an invitation to bypass the routing decision.
 */

export { ViewUpdateContext, selectViewUpdateStrategy } from './ViewUpdateContext';
export {
  buildViewFieldPatch,
  buildViewUpdatePayload,
  buildViewFilter,
  buildBucketConfiguration,
  translateViewFilter,
} from './mapping';
export type {
  ViewUpdateInput,
  ViewUpdateStrategy,
  ViewFieldUpdates,
  ViewBucketConfigurationInput,
  ViewKind,
  BucketConfigurationMode,
  VikunjaProjectView,
  VikunjaTaskCollection,
  VikunjaBucketConfiguration,
} from './types';
