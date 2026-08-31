/**
 * MCP Server Error Types and Utilities
 */

export enum ErrorCode {
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  AUTH_FAILED = 'AUTH_FAILED',
  NOT_FOUND = 'NOT_FOUND',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  API_ERROR = 'API_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  REQUEST_TOO_LARGE = 'REQUEST_TOO_LARGE',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
}

interface MCPErrorDetails {
  vikunjaError?: unknown;
  statusCode?: number;
  endpoint?: string;
  // Rate limiting specific properties
  rateLimitType?: string;
  requestSize?: number;
  responseSize?: number;
  timeout?: number;
  limit?: number;
  current?: number;
  resetTime?: number;
  maxRequestSize?: number;
  maxResponseSize?: number;
  toolName?: string;
  /**
   * Set by network-layer failures wrapped into an MCPError (e.g.
   * src/utils/vikunja-rest.ts) to record whether the original cause looked
   * transient (connection reset, timeout, DNS failure, ...) BEFORE the
   * original error's `.code`/`.cause.code` — which callers like a retry
   * predicate need — got discarded by the string-formatted MCPError
   * message. Absent for non-network failures (e.g. HTTP error responses,
   * which use `statusCode` instead).
   */
  transient?: boolean;
  /**
   * Set by network-layer failures wrapped into an MCPError (see
   * `transient` above) when the original cause proves the request was never
   * delivered — connection refused, host not resolved, network unreachable,
   * or the TCP/TLS handshake itself timed out. Distinct from `transient`,
   * which is also true for mid-flight failures (ECONNRESET, read timeouts)
   * where the server may well have committed the write before the response
   * was lost. Retry predicates for non-idempotent writes
   * (`shouldRetryNonIdempotentWrite` in src/utils/vikunja-rest.ts) use this
   * to distinguish "provably nothing happened" from merely "transient".
   */
  preRequest?: boolean;
  /**
   * Set when the failure is the CALLER giving up, not the server failing:
   * the tool-execution deadline (src/middleware/simplified-rate-limit.ts)
   * aborted an in-flight request. Distinct from `transient` — nothing is
   * known to be wrong upstream — which is why
   * `isClientErrorExcludedFromBreaker` (src/utils/retry.ts) keeps these out
   * of the shared circuit breakers' failure statistics.
   */
  cancelled?: boolean;
  /**
   * Set by OIDC bearer-token validation failures (src/auth/oidc/jwtValidator.ts)
   * so an HTTP transport can build the `WWW-Authenticate: Bearer error="..."`
   * header per RFC 6750 without re-deriving it from `code`/`statusCode`.
   * `invalid_token` pairs with `statusCode: 401`; `insufficient_scope` pairs
   * with `statusCode: 403`.
   */
  wwwAuthenticateError?: 'invalid_token' | 'insufficient_scope';
}

export class MCPError extends Error {
  code: ErrorCode;
  details?: MCPErrorDetails;

  constructor(code: ErrorCode, message: string, details?: MCPErrorDetails) {
    super(message);
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
    this.name = 'MCPError';
  }

  toJSON(): { error: { code: string; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}

export interface MCPResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}
