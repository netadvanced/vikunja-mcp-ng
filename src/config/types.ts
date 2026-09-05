/**
 * Configuration Types and Schemas
 * Centralized configuration management for the Vikunja MCP server
 */

import { z } from 'zod';

// Environment type for configuration profiles
export enum Environment {
  DEVELOPMENT = 'development',
  TEST = 'test',
  PRODUCTION = 'production',
}

// Authentication Configuration Schema
export const AuthConfigSchema = z.object({
  vikunjaUrl: z.string().url().optional(),
  vikunjaToken: z.string().optional(),
  mcpMode: z.string().optional(),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

// Logging Configuration Schema
export const LoggingConfigSchema = z.object({
  level: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  debug: z.boolean().default(false),
  environment: z.nativeEnum(Environment).default(Environment.DEVELOPMENT),
});

export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

// Individual rate limit settings schema
const RateLimitSettingsSchema = z.object({
  requestsPerMinute: z.number().int().positive().default(60),
  requestsPerHour: z.number().int().positive().default(1000),
  maxRequestSize: z.number().int().positive().default(1048576), // 1MB
  maxResponseSize: z.number().int().positive().default(10485760), // 10MB
  executionTimeout: z.number().int().positive().default(30000), // 30 seconds
});

// Rate Limiting Configuration Schema
export const RateLimitConfigSchema = z.object({
  // Global enable/disable switch for rate limiting
  enabled: z.boolean().default(true),

  // Default tool limits
  default: RateLimitSettingsSchema.default({
    requestsPerMinute: 60,
    requestsPerHour: 1000,
    maxRequestSize: 1048576,
    maxResponseSize: 10485760,
    executionTimeout: 30000,
  }),

  // Expensive tool limits
  expensive: RateLimitSettingsSchema.default({
    requestsPerMinute: 10,
    requestsPerHour: 100,
    maxRequestSize: 2097152,
    maxResponseSize: 52428800,
    executionTimeout: 120000,
  }),

  // Bulk operation limits
  bulk: RateLimitSettingsSchema.default({
    requestsPerMinute: 5,
    requestsPerHour: 50,
    maxRequestSize: 5242880,
    maxResponseSize: 104857600,
    executionTimeout: 300000,
  }),

  // Export operation limits
  export: RateLimitSettingsSchema.default({
    requestsPerMinute: 2,
    requestsPerHour: 10,
    maxRequestSize: 1048576,
    maxResponseSize: 1073741824,
    executionTimeout: 600000,
  }),
});

export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

// Feature Flags Configuration Schema
export const FeatureFlagsConfigSchema = z.object({
  enableServerSideFiltering: z.boolean().default(true),
  enableAdvancedMetrics: z.boolean().default(false),
  enableExperimentalFeatures: z.boolean().default(false),
  // Kill switch for the v2 API fast path: when true, every operation uses
  // the v1 API even if this session's capability probe reported v2 support.
  // Config file key: `featureFlags.forceV1Api`. Env override:
  // `VIKUNJA_MCP_FORCE_V1_API` (env always wins, per standard layering).
  // Deliberately absent from ENVIRONMENT_PROFILES so it stays false in every
  // environment unless explicitly set. See src/utils/api-version.ts.
  forceV1Api: z.boolean().default(false),
});

export type FeatureFlagsConfig = z.infer<typeof FeatureFlagsConfigSchema>;

// Module Enable/Disable Configuration Schema
//
// A module value is a plain boolean today ({"tasks": false}), but the object
// form ({"tasks": {"enabled": true, "delete": false}}) is accepted now so that
// per-subcommand granularity can be introduced later without a breaking change.
// The `.catchall(z.boolean())` allows arbitrary future subcommand keys through
// validation; only `enabled` is interpreted today (see `isModuleEnabled`).
export const ModuleToggleSchema = z.union([
  z.boolean(),
  z.object({ enabled: z.boolean() }).catchall(z.boolean()),
]);

export type ModuleToggle = z.infer<typeof ModuleToggleSchema>;

/**
 * Resolve a module toggle (boolean shorthand or object form) to its
 * effective enabled/disabled state.
 */
export function isModuleEnabled(toggle: ModuleToggle): boolean {
  return typeof toggle === 'boolean' ? toggle : toggle.enabled;
}

// Modules deliberately excluded from ordinary defaults because they are
// dangerous/destructive in nature. These have no registered tools yet, but
// the config keys are reserved now so future admin/user-deletion/token-
// management tools plug into the same deny-by-default gating from day one.
export const DANGEROUS_MODULE_KEYS = [
  'admin',
  'userDeletion',
  'tokenManagement',
  'caldavTokens',
] as const;

export const ModulesConfigSchema = z.object({
  // Ordinary modules — default ON.
  tasks: ModuleToggleSchema.default(true),
  projects: ModuleToggleSchema.default(true),
  labels: ModuleToggleSchema.default(true),
  teams: ModuleToggleSchema.default(true),
  users: ModuleToggleSchema.default(true),
  webhooks: ModuleToggleSchema.default(true),
  filters: ModuleToggleSchema.default(true),
  templates: ModuleToggleSchema.default(true),
  export: ModuleToggleSchema.default(true),
  batchImport: ModuleToggleSchema.default(true),
  notifications: ModuleToggleSchema.default(true),
  subscriptions: ModuleToggleSchema.default(true),
  reactions: ModuleToggleSchema.default(true),

  // Dangerous modules — deny-by-default. No tools implement these yet; the
  // keys are reserved so future work composes with this gating system.
  admin: ModuleToggleSchema.default(false),
  userDeletion: ModuleToggleSchema.default(false),
  tokenManagement: ModuleToggleSchema.default(false),

  // Gates `vikunja_caldav_tokens` (CalDAV token list/create/delete for the
  // connected account). Deny-by-default — credential-adjacent, and a
  // created token's secret value is only ever shown once (see
  // src/tools/caldav-tokens.ts). Unlike `tokenManagement`, the underlying
  // `/user/settings/token/caldav*` endpoints are JWT-only per the vendored
  // OpenAPI spec (`security: [{JWTKeyAuth: []}]`), so registration composes
  // with the same JWT-only gate as `users`/`export`/`admin` — see
  // src/tools/index.ts.
  caldavTokens: ModuleToggleSchema.default(false),

  // Opt-in cosmetic module — deny-by-default for the OPPOSITE reason the
  // dangerous keys above are: not dangerous, just low-value for a task-
  // management assistant (project backgrounds are decorative, not
  // functional). Gates three `vikunja_projects` subcommands
  // (`remove-background`/`set-unsplash-background`/`search-unsplash`, see
  // `src/tools/projects/backgrounds.ts`) rather than a whole standalone
  // tool — see that module's doc comment and
  // `registerProjectsTool`/`resolveBackgroundsEnabled` in
  // `src/tools/projects/index.ts` for how a single tool's subcommand *enum*
  // (not just its dispatch) is built conditionally so the disabled
  // subcommands are genuinely absent from the schema, matching every other
  // module's "invisible, not merely rejected" contract. See
  // docs/ENDPOINT-TAIL-RETRIAGE.md item G7.
  backgrounds: ModuleToggleSchema.default(false),
});

export type ModulesConfig = z.infer<typeof ModulesConfigSchema>;

// Templates Configuration Schema
//
// Templates are in-memory-only (session-scoped, lost on restart) unless
// `persistPath` is set, in which case the vikunja_templates tool write-
// throughs to that file on every mutation and reloads from it at startup.
// See docs/CONFIGURATION.md for the env var / Docker volume story.
export const TemplatesConfigSchema = z.object({
  persistPath: z.string().optional(),
});

export type TemplatesConfig = z.infer<typeof TemplatesConfigSchema>;

// Transport mode. `stdio` (default) is the existing single-tenant behavior
// and MUST stay byte-for-byte unchanged. `http` is the new opt-in
// Streamable HTTP transport (see docs/OIDC-RESOURCE-SERVER.md §2/§3a) — it
// requires the OIDC middleware seam (item H1b) to be registered before it
// will actually serve traffic; see src/transport/oidcMiddlewareSeam.ts.
export const TransportModeSchema = z.enum(['stdio', 'http']);

export type TransportMode = z.infer<typeof TransportModeSchema>;

// HTTP transport configuration (docs/OIDC-RESOURCE-SERVER.md §2.1, §3a).
//
// Host binding defaults to loopback (`127.0.0.1`) — a misconfigured
// deployment fails closed (unreachable) rather than exposing an
// unauthenticated-looking port to the LAN. `allowedHosts` feeds the SDK
// transport's DNS-rebinding protection (`enableDnsRebindingProtection`,
// always on for `http` mode); when unset, it defaults to `host:port` so the
// default loopback binding gets working protection out of the box.
export const HttpConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().positive().max(65535).default(8765),
  path: z.string().min(1).default('/mcp'),
  allowedHosts: z.array(z.string()).optional(),
  // Canonical public URL of the MCP endpoint (`http.publicUrl` /
  // `VIKUNJA_MCP_HTTP_PUBLIC_URL`), e.g. `https://mcp-vikunja.example.ch/mcp`.
  // Used as the RFC 9728 `resource` value on the
  // `/.well-known/oauth-protected-resource` discovery document and to build
  // the `resource_metadata` URL on 401 challenges
  // (src/transport/resourceMetadata.ts). Optional: when unset, both are
  // derived per-request from the `Host` header (+ `X-Forwarded-Proto`) and
  // the configured `http.path` — setting it explicitly is recommended behind
  // a reverse proxy, where the bind host/port say nothing about the public
  // origin.
  publicUrl: z.string().url().optional(),
});

export type HttpConfig = z.infer<typeof HttpConfigSchema>;

// OIDC resource-server configuration (docs/OIDC-RESOURCE-SERVER.md §2.1, §3b).
//
// Consumed only when `transport=http` — it is the config half of the
// deny-mixed-mode rule (§2 "Selection rule"): `http` mode with no `oidc`
// block refuses to start (never serve unauthenticated HTTP), and an
// incomplete block (e.g. `issuer` without `audience`/`jwksUri`) is a hard
// config-validation error rather than a silent downgrade. Field names mirror
// the JWT validator's `OidcJwtValidatorConfig` (src/auth/oidc/types.ts) 1:1;
// the HTTP-auth wiring (src/transport/oidcHttpAuth.ts) maps straight across.
export const OidcConfigSchema = z.object({
  // Exact-match trusted issuer (`oidc.issuer`), compared with plain string
  // equality — no prefix matching.
  issuer: z.string().min(1),
  // Required audience value(s) (`oidc.audience`). Env form is a
  // comma-separated list; a single value stays a string.
  audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  // JWKS endpoint URL to fetch signing keys from (`oidc.jwksUri`).
  jwksUri: z.string().url(),
  // Allowed JWS `alg` values (`oidc.allowedAlgs`). Defaults (in the validator)
  // to `['RS256']`; `none` is never accepted.
  allowedAlgs: z.array(z.string().min(1)).min(1).optional(),
  // Bounded clock-skew tolerance in seconds (`oidc.clockSkewSec`), applied to
  // `exp`/`nbf`/`iat`. Validator default: 60.
  clockSkewSec: z.number().int().nonnegative().optional(),
  // Optional coarse scope gate (`oidc.requiredScope`) — a validly
  // authenticated token missing it is a 403, not a 401.
  requiredScope: z.string().min(1).optional(),
});

export type OidcConfig = z.infer<typeof OidcConfigSchema>;

// Credential vault configuration (docs/OIDC-RESOURCE-SERVER.md §3c, D1/D4).
//
// Only meaningful in `oidc-http` mode: the vault maps validated `(issuer,
// sub)` identities to an encrypted Vikunja `tk_` token (H2's real
// `src/storage/vaultFileStore.ts`, replacing H1's `OidcStubCredentialSource`).
// `path` is not secret (it's just a filesystem location); the master
// encryption key (`VIKUNJA_MCP_VAULT_KEY[_FILE]`) rides the existing `_FILE`
// secrets convention instead (`src/config/secrets.ts`, `SENSITIVE_ENV_VARS`)
// and is never part of this config schema — never written to the
// config-file, only ever read from the environment.
export const VaultConfigSchema = z.object({
  path: z.string().min(1).optional(),
});

export type VaultConfig = z.infer<typeof VaultConfigSchema>;

// SSO enrollment configuration (issue #220, docs/OIDC-SETUP.md §"One-click
// SSO enrollment").
//
// Only meaningful in `oidc-http` mode, and opt-in (`enabled` defaults to
// false): when enabled, an unprovisioned identity's `vikunja_auth provision`
// call (with no token) returns a short-lived enrollment URL instead of an
// error, and the HTTP transport serves the browser half of the flow
// (`GET /enroll` + `GET /enroll/callback`) that turns one IdP authorization
// hop into a vaulted per-user Vikunja `tk_*` token — no token pasting.
// Requires the Vikunja backend itself to have an OpenID provider configured
// for the SAME IdP (Vikunja's native `auth.openid.providers`).
export const EnrollConfigSchema = z.object({
  // Master switch (`VIKUNJA_MCP_ENROLL_ENABLED`). Off by default — manual
  // token provisioning keeps working either way.
  enabled: z.boolean().default(false),
  // The Vikunja OpenID provider to enroll through, matched against the
  // provider `key` (or `name`) reported by Vikunja's `GET /info`
  // (`VIKUNJA_MCP_ENROLL_PROVIDER`). Optional: when the backend has exactly
  // one provider, it is used automatically.
  provider: z.string().min(1).optional(),
  // The Vikunja API base URL the enrollment flow talks to
  // (`VIKUNJA_MCP_ENROLL_VIKUNJA_URL`), e.g. `https://vikunja.example/api/v1`.
  // Defaults to the shared `auth.vikunjaUrl` (`VIKUNJA_URL`) when omitted.
  vikunjaUrl: z.string().url().optional(),
  // Expiry, in days, of the auto-minted per-user Vikunja API token
  // (`VIKUNJA_MCP_ENROLL_TOKEN_EXPIRY_DAYS`). Default: 365. When a token
  // expires the user simply re-runs `vikunja_auth provision` and clicks the
  // link again — re-enrollment mints and vaults a fresh token.
  tokenExpiryDays: z.number().int().positive().default(365),
  // Enrollment ticket lifetime in seconds (`VIKUNJA_MCP_ENROLL_TICKET_TTL_SEC`)
  // — how long the returned enrollment URL stays clickable. Default: 600.
  ticketTtlSec: z.number().int().positive().default(600),
});

export type EnrollConfig = z.infer<typeof EnrollConfigSchema>;

// Complete Application Configuration Schema
export const ApplicationConfigSchema = z.object({
  environment: z.nativeEnum(Environment).default(Environment.DEVELOPMENT),
  auth: AuthConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  rateLimiting: RateLimitConfigSchema.default({}),
  featureFlags: FeatureFlagsConfigSchema.default({}),
  modules: ModulesConfigSchema.default({}),
  // Global read-only safety mode. When true, every write/destructive
  // subcommand across every tool is rejected at dispatch (see
  // src/utils/read-only.ts) — read subcommands continue to work normally.
  // Config file key: `readOnly`. Env override: `VIKUNJA_MCP_READ_ONLY`
  // (env always wins over the config file, per standard layering).
  readOnly: z.boolean().default(false),
  templates: TemplatesConfigSchema.default({}),
  // Transport mode switch (docs/OIDC-RESOURCE-SERVER.md §2). Defaults to
  // `stdio` — today's single-tenant behavior, unchanged. `http` opts into
  // the Streamable HTTP transport and, without the OIDC middleware seam
  // registered, refuses to start (never serve unauthenticated HTTP).
  transport: TransportModeSchema.default('stdio'),
  http: HttpConfigSchema.default({}),
  // OIDC resource-server config (docs/OIDC-RESOURCE-SERVER.md §3b). Optional
  // and only meaningful in `http` mode — its presence is what lets `http`
  // mode actually start (the JWT-validation middleware is built from it and
  // registered on the transport's auth seam before the listener opens).
  // Absent in `stdio` mode, which never reads it.
  oidc: OidcConfigSchema.optional(),
  // Credential vault path config (docs/OIDC-RESOURCE-SERVER.md §3c). Only
  // consulted in `oidc-http` mode; `stdio` mode never reads it.
  vault: VaultConfigSchema.default({}),
  // One-click SSO enrollment (issue #220). Opt-in, oidc-http mode only.
  enroll: EnrollConfigSchema.default({}),
})
  // Cross-field contract for SSO enrollment (issue #220, review finding #7):
  // `enroll.enabled` is only meaningful in oidc-http mode with a public URL —
  // anywhere else it MUST be a hard config error, never a silent no-op. An
  // operator who set VIKUNJA_MCP_ENROLL_ENABLED=true and got no /enroll
  // endpoints would otherwise debug a ghost.
  .superRefine((config, ctx) => {
    if (!config.enroll.enabled) {
      return;
    }
    if (config.transport !== 'http') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['enroll', 'enabled'],
        message:
          'SSO enrollment (VIKUNJA_MCP_ENROLL_ENABLED) requires transport=http — it is ' +
          'meaningless under stdio, which has no per-identity vault or browser endpoints. ' +
          'Set VIKUNJA_MCP_TRANSPORT=http or disable enrollment.',
      });
    }
    if (config.oidc === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['enroll', 'enabled'],
        message:
          'SSO enrollment requires the OIDC resource-server config (VIKUNJA_MCP_OIDC_*) — ' +
          'enrollment tickets are minted for OIDC-validated identities only.',
      });
    }
    if (config.http.publicUrl === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['http', 'publicUrl'],
        message:
          'SSO enrollment requires the canonical public MCP URL ' +
          '(VIKUNJA_MCP_HTTP_PUBLIC_URL) — enrollment links and the OAuth redirect_uri are ' +
          'built from it and must be browser-reachable and IdP-whitelisted.',
      });
    }
  });

export type ApplicationConfig = z.infer<typeof ApplicationConfigSchema>;

// Configuration Validation Error
export class ConfigurationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
    public readonly value?: unknown,
  ) {
    super(`Configuration error in ${field}: ${message}`);
    this.name = 'ConfigurationError';
  }
}

// Configuration Load Options
export interface ConfigLoadOptions {
  /** Override default environment detection */
  environment?: Environment;
  /** Throw on missing optional values */
  strict?: boolean;
  /** Custom environment variable prefix */
  prefix?: string;
  /** Additional configuration sources */
  sources?: Record<string, unknown>;
}
