/**
 * Auth Module Exports - Simplified
 * Eliminated over-engineered testing infrastructure
 */

export { AuthManager } from './AuthManager';
export {
  Permission,
  PermissionManager,
  TOOL_PERMISSIONS,
  type PermissionCheckResult,
} from './permissions';
export { createOidcJwtValidator, type OidcJwtValidator } from './oidc/jwtValidator';
export { loadJose } from './oidc/joseLoader';
export type {
  Identity,
  JoseDeps,
  JoseCreateRemoteJWKSet,
  JoseJwtVerify,
  OidcJwksCacheConfig,
  OidcJwtValidatorConfig,
} from './oidc/types';
