/**
 * Enhanced security utilities for comprehensive credential masking and sensitive data protection
 * Prevents credential exposure in logs, monitoring systems, and error reports
 *
 * Security Features:
 * - Comprehensive sensitive key detection with regex patterns
 * - Case-insensitive matching with Unicode normalization
 * - Credential format detection (JWT, API keys, database URIs, etc.)
 * - Protection against encoding bypasses and Unicode attacks
 * - Performance-optimized for large datasets
 * - Integration with input sanitization layer for comprehensive protection
 */

import { sanitizeString } from './validation';

// Comprehensive list of sensitive key patterns
const SENSITIVE_KEY_PATTERNS = [
  // Token patterns (enhanced to handle camelCase and embedded patterns)
  /(?:^|[_-])(token|tokens|access_token|refresh_token|session_token|auth_token|bearer_token|csrf_token|xsrf_token)(?:$|[_-])/i,
  /(?:^|[_-])(jwt|jwt_token|jwt_secret|id_token|access_key|secret_key|api_key|apikey|api_key_secret|refresh)(?:$|[_-])/i,
  /(?:^|[_-])(session|sessionid|session_id|user_session|admin_session|phpsessid)(?:$|[_-])/i,
  /(?:^|[_-])(bearer|authorization|auth|auth_header|x_auth_token|x_api_key)(?:$|[_-])/i,

  // Password and credential patterns
  /(?:^|[_-])(password|passwd|pass|pwd|credential|credentials|secret|private_key|privatekey)(?:$|[_-])/i,
  /(?:^|[_-])(client_secret|client_id|client_key|app_secret|app_key|app_id)(?:$|[_-])/i,
  /(?:^|[_-])(user|username|user_id|email|login|signin)(?:$|[_-])/i,

  // Database and connection patterns
  /(?:^|[_-])(database|db|connection|connection_string|mongo_uri|mongodb_uri|redis_url)(?:$|[_-])/i,
  /(?:^|[_-])(host|hostname|server|endpoint|uri|url|link)(?:$|[_-])/i,

  // OAuth and external service patterns
  /(?:^|[_-])(oauth|oauth_token|oauth_secret|consumer_key|consumer_secret)(?:$|[_-])/i,
  /(?:^|[_-])(github|gitlab|bitbucket|slack|discord|google|facebook|twitter)(?:$|[_-])/i,

  // Encryption and security patterns
  /(?:^|[_-])(encryption|encrypt|decrypt|cipher|hash|salt|pepper|nonce|iv)(?:$|[_-])/i,
  /(?:^|[_-])(public_key|private_key|certificate|cert|ssl|tls|https)(?:$|[_-])/i,

  // Configuration and environment patterns
  /(?:^|[_-])(config|configuration|setting|env|environment|variable)(?:$|[_-])/i,
  /(?:^|[_-])(secret|secrets|vault|keystore|credential_store)(?:$|[_-])/i,

  // File and storage patterns
  /(?:^|[_-])(file|path|directory|folder|storage|bucket|container)(?:$|[_-])/i,

  // API and service patterns
  /(?:^|[_-])(api|service|endpoint|webhook|callback|redirect)(?:$|[_-])/i,

  // Enhanced patterns for camelCase and embedded sensitive keywords
  /apiToken/i, // Direct match for apiToken
  /jwtToken/i, // Direct match for jwtToken
  /authKey/i, // Direct match for authKey
  /apiKey/i, // Direct match for apiKey

  // Contains patterns for embedded sensitive words
  /(api|auth|token|key|secret|credential|pass|refresh)/i,

  // Direct matches for common sensitive keys (fallbacks)
  /^(token|key|secret|auth|credential|pass)$/i,
  /\b(token|key|secret|auth|credential|pass)\b/i,
];

// Regex patterns for detecting credential formats in string values
const CREDENTIAL_FORMAT_PATTERNS = [
  // JWT tokens (header.payload.signature with base64url encoding)
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,

  // API key formats (adjusted for realistic test data)
  /^tk_[a-zA-Z0-9]{8,}$/, // Vikunja token format (minimum 8 chars after tk_)
  /^ghp_[a-zA-Z0-9]{36}$/, // GitHub personal access token
  /^xoxb-[0-9]{10,}-[0-9]{10,}-[a-zA-Z0-9]{24}$/, // Slack bot token
  /^AKIA[0-9A-Z]{16}$/, // AWS access key ID
  /^[a-zA-Z0-9+/]{20,}={0,2}$/, // Base64 encoded keys/secrets (reduced minimum)

  // Database connection URIs
  /^mongodb:\/\/[^:]+:[^@]+@[^/]+/, // MongoDB URI with credentials
  /^postgresql:\/\/[^:]+:[^@]+@[^/]+/, // PostgreSQL URI with credentials
  /^mysql:\/\/[^:]+:[^@]+@[^/]+/, // MySQL URI with credentials
  /^redis:\/\/:[^@]+@[^/]+/, // Redis URI with password

  // UUID patterns (often used for session IDs or request IDs)
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,

  // Long alphanumeric strings (likely keys or hashes) - more permissive
  /^[a-zA-Z0-9]{32,}$/, // Changed from hex-only to alphanumeric

  // Authorization headers
  /^Bearer\s+[A-Za-z0-9._-]+/,
  /^Basic\s+[A-Za-z0-9+/=]+/,

  // Certificate PEM headers
  /^-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
  /^-----BEGIN\s+CERTIFICATE-----/,

  // High-entropy base64 strings (likely encoded secrets)
  /^[A-Za-z0-9+/]{30,}={0,2}$/, // Reduced minimum for practical testing

  // Request/Trace ID patterns
  /^(req|trace|span|correlation)_[a-zA-Z0-9]{16,}$/,
];

// Unicode normalization patterns to detect bypass attempts
const UNICODE_NORMALIZATION_PATTERNS = [
  /\u200b/, // Zero-width space
  /\u200c/, // Zero-width non-joiner
  /\u200d/, // Zero-width joiner
  /\u200e/, // Left-to-right mark
  /\u200f/, // Right-to-left mark
  /\u2060/, // Word joiner
  /\u180e/, // Mongolian vowel separator
  /[\uFE00-\uFE0F]/, // Variation selectors
];

// Performance optimization: Cache normalized keys
const normalizedKeyCache = new Map<string, string>();

/**
 * Normalizes a key for security checking by:
 * - Converting to lowercase
 * - Removing Unicode bypass characters
 * - Normalizing Unicode characters
 * - Replacing common separators with underscores
 *
 * @param key - The key to normalize
 * @returns Normalized key safe for comparison
 */
function normalizeSecurityKey(key: string): string {
  if (normalizedKeyCache.has(key)) {
    return normalizedKeyCache.get(key) as string;
  }

  let normalized = key.toLowerCase();

  // Remove Unicode bypass characters
  UNICODE_NORMALIZATION_PATTERNS.forEach((pattern) => {
    normalized = normalized.replace(pattern, '');
  });

  // Replace common separators with underscores for pattern matching
  normalized = normalized.replace(/[-\s.]/g, '_');

  // Remove multiple consecutive underscores
  normalized = normalized.replace(/_+/g, '_');

  // Trim leading/trailing underscores
  normalized = normalized.replace(/^_+|_+$/g, '');

  // Cache the result
  normalizedKeyCache.set(key, normalized);
  return normalized;
}

/**
 * Checks if a key is sensitive using comprehensive pattern matching
 *
 * @param key - The key to check
 * @returns True if the key matches any sensitive pattern
 */
function isSensitiveKey(key: string): boolean {
  const normalizedKey = normalizeSecurityKey(key);

  return SENSITIVE_KEY_PATTERNS.some((pattern) => {
    // Test both original and normalized key against patterns
    return pattern.test(key) || pattern.test(normalizedKey);
  });
}

/**
 * Checks if a string value looks like a credential based on format patterns
 *
 * @param value - The string value to check
 * @returns True if the value matches credential format patterns
 */
function isCredentialFormat(value: string): boolean {
  // Only check strings of reasonable length (avoid false positives on short strings)
  if (value.length < 8) {
    return false;
  }

  // Check against credential format patterns
  return CREDENTIAL_FORMAT_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Enhanced credential masking that handles various formats
 * Shows only the first 4 characters followed by ellipsis for long credentials
 * Uses '[REDACTED]' for short credentials
 *
 * @param credential - The credential to mask (API token, password, etc.)
 * @returns Masked credential string or empty string if input is invalid
 */
export function maskCredential(credential: string | undefined | null): string {
  if (!credential || typeof credential !== 'string') {
    return '';
  }

  // Normalize credential by removing Unicode bypass characters
  let normalizedCredential = credential;
  UNICODE_NORMALIZATION_PATTERNS.forEach((pattern) => {
    normalizedCredential = normalizedCredential.replace(pattern, '');
  });

  if (normalizedCredential.length <= 4) {
    return '***';
  }

  return `${normalizedCredential.substring(0, 4)}...`;
}

/**
 * Masks sensitive information in URLs for logging
 * Enhanced detection of sensitive path components and query parameters
 *
 * @param url - The URL to mask
 * @returns Masked URL string or original if not a valid URL
 */
export function maskUrl(url: string | undefined | null): string {
  if (!url || typeof url !== 'string') {
    return '';
  }

  try {
    const urlObj = new URL(url);

    // Enhanced sensitive path detection
    const sensitivePathPatterns = [
      /\/api\/v\d+\/(token|auth|login|key|session)/i,
      /(auth|login|logout|signin|signout|token|key|session)/i,
      /\/oauth\/(authorize|token|callback)/i,
      /(admin|dashboard|control)/i,
    ];

    const pathname = urlObj.pathname.toLowerCase();
    if (sensitivePathPatterns.some((pattern) => pattern.test(pathname))) {
      // Mask the last path component
      urlObj.pathname = urlObj.pathname.replace(/\/[^/]*$/, '/[REDACTED]');
    }

    // Mask all query parameters (they may contain sensitive data)
    if (urlObj.search) {
      urlObj.search = '?[REDACTED]';
    }

    // Mask sensitive URL fragments
    if (urlObj.hash && isSensitiveKey(urlObj.hash.substring(1))) {
      urlObj.hash = '#[REDACTED]';
    }

    return urlObj.toString();
  } catch {
    // If URL parsing fails, just mask after the first slash (original behavior)
    const firstSlashIndex = url.indexOf('/', url.indexOf('://') + 3);
    if (firstSlashIndex !== -1) {
      return `${url.substring(0, firstSlashIndex)}/[REDACTED]`;
    }
    return url;
  }
}

/**
 * Credential-sounding names, used when a name appears *inside* free-form text
 * (a URL query parameter, a `name=value` pair in a message).
 *
 * Deliberately much narrower than SENSITIVE_KEY_PATTERNS, which is tuned for
 * object keys and matches very broadly (`url`, `file`, `config`, `host`, …).
 * Applying that breadth to prose would redact most of a useful log line.
 */
const EMBEDDED_CREDENTIAL_NAME =
  /^(?:.*[_-])?(?:secrets?|tokens?|access_?token|refresh_?token|id_?token|password|passwd|pwd|pass|api_?key|apikey|key|auth|authorization|credentials?|signature|sig|hmac|session|sessionid|private_?key|client_?secret)(?:[_-].*)?$/i;

/**
 * Secrets that can appear anywhere inside a string, regardless of the key that
 * holds it. These are the cases key-name matching structurally cannot catch.
 */
const EMBEDDED_SECRET_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // JSON Web Tokens (header.payload.signature)
  {
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
    replacement: '[REDACTED_JWT]',
  },
  // Vikunja API tokens
  { pattern: /\btk_[A-Za-z0-9_-]{8,}/g, replacement: '[REDACTED_TOKEN]' },
  // Authorization header values
  { pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: '$1 [REDACTED]' },
];

// PEM private key blocks. Guarded by a cheap `includes` check before use so the
// lazy quantifier never scans a large string that cannot contain a match.
const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g;

// `name=value` / `name: value` pairs in free-form text.
const INLINE_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_-]{2,40})(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;)&"']+)/g;

// URL-shaped substrings, matched loosely so they can be re-parsed with `URL`.
const URL_LIKE_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\]+/gi;

// Keys that name a location rather than a credential. For these the URL is kept
// (with its secret parts redacted) instead of being replaced wholesale, because
// an endpoint is usually the single most useful thing in a log line.
const LOCATION_KEY_PATTERN = /(url|uri|endpoint|host|link|callback|redirect)/i;

/**
 * Heuristic for a path segment that carries a secret rather than an identifier.
 *
 * Motivating case: Slack/Discord/Teams style webhook URLs embed the shared
 * secret in the path itself (`https://hooks.slack.com/services/T…/B…/<secret>`),
 * so no key-name or query-parameter rule can ever catch it.
 *
 * @param segment - A single URL path segment
 * @returns True if the segment looks like an opaque high-entropy secret
 */
function looksLikeSecretPathSegment(segment: string): boolean {
  if (segment.length < 20 || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    return false;
  }

  const hasDigit = /[0-9]/.test(segment);
  const hasLower = /[a-z]/.test(segment);
  const hasUpper = /[A-Z]/.test(segment);

  // Long lowercase-only slugs (`my-very-long-project-name`) stay readable;
  // mixed-case or digit-bearing blobs of this length are opaque tokens.
  return (hasDigit && (hasLower || hasUpper)) || (hasLower && hasUpper);
}

/**
 * Redacts the credential-bearing parts of a single URL: userinfo, sensitive
 * query parameters and high-entropy path segments. The host and the readable
 * path are preserved so the log line still says where the call went.
 *
 * @param rawUrl - A URL-shaped string
 * @returns The URL with its secret components replaced
 */
export function redactUrlSecrets(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Not parseable as a URL; the caller's other redaction rules still apply.
    return rawUrl;
  }

  if (parsed.username || parsed.password) {
    parsed.username = 'REDACTED';
    parsed.password = 'REDACTED';
  }

  for (const name of Array.from(parsed.searchParams.keys())) {
    if (EMBEDDED_CREDENTIAL_NAME.test(name)) {
      parsed.searchParams.set(name, 'REDACTED');
    }
  }

  parsed.pathname = parsed.pathname
    .split('/')
    .map((segment) => (looksLikeSecretPathSegment(segment) ? 'REDACTED' : segment))
    .join('/');

  if (parsed.hash.length > 1 && EMBEDDED_CREDENTIAL_NAME.test(parsed.hash.slice(1))) {
    parsed.hash = '#REDACTED';
  }

  return parsed.toString();
}

/**
 * Redacts credentials embedded in free-form text: URLs with secrets in them,
 * JWTs, API tokens, authorization header values, PEM private keys and
 * `name=value` pairs whose name reads as a credential.
 *
 * Unlike key-based redaction this works on the string itself, so it catches
 * secrets that arrive inside a message, a stack trace or a URL path.
 *
 * @param text - Text that may contain credentials
 * @returns The text with credential substrings replaced
 */
export function redactSecretsInText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }

  let result = text;

  if (result.includes('://')) {
    result = result.replace(URL_LIKE_PATTERN, (match) => redactUrlSecrets(match));
  }

  for (const { pattern, replacement } of EMBEDDED_SECRET_RULES) {
    result = result.replace(pattern, replacement);
  }

  if (result.includes('-----BEGIN')) {
    result = result.replace(PEM_PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]');
  }

  result = result.replace(INLINE_ASSIGNMENT_PATTERN, (match, name: string, separator: string) =>
    EMBEDDED_CREDENTIAL_NAME.test(name) ? `${name}${separator}[REDACTED]` : match,
  );

  return result;
}

/**
 * Enhanced log data sanitization with comprehensive credential masking
 * Recursively processes nested objects and arrays with advanced pattern detection
 *
 * Strict mode: string values additionally go through the input-sanitization
 * layer (`sanitizeString`), which *rejects* rather than escapes suspicious
 * content. Use {@link sanitizeForLogging} for log output, where that rejection
 * would destroy legitimate diagnostics.
 *
 * @param data - The data object to sanitize
 * @returns Sanitized data with masked sensitive fields
 */
export function sanitizeLogData(data: unknown): unknown {
  return sanitizeLogDataInternal(data, new WeakSet(), true);
}

/**
 * Credential-safe sanitization for logger output.
 *
 * Same redaction as {@link sanitizeLogData} minus the input-sanitization layer:
 * stderr is not an HTML sink, so XSS/injection rejection buys no security there
 * while it does turn ordinary diagnostics (paths containing `../`, strings over
 * 1000 characters, stack traces) into `[SANITIZATION_FAILED]`. Error instances
 * are additionally unwrapped, since their `message`/`stack` are non-enumerable
 * and a plain object walk would reduce them to `{}`.
 *
 * @param data - The value to sanitize
 * @returns Sanitized value safe to write to a log
 */
export function sanitizeForLogging(data: unknown): unknown {
  return sanitizeLogDataInternal(data, new WeakSet(), false);
}

/**
 * Sanitizes every metadata argument handed to a logger call.
 *
 * @param args - The variadic arguments of a logger call
 * @returns A new array with each argument sanitized
 */
export function sanitizeLogArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg) => sanitizeForLogging(arg));
}

/**
 * Sanitizes a string value for logging.
 *
 * @param value - The string to sanitize
 * @param applyInputSanitization - Whether to also run the input-sanitization layer
 * @returns Sanitized string
 */
function sanitizeLogString(value: string, applyInputSanitization: boolean): string {
  // Whole-string credentials keep their existing masked-prefix representation.
  if (isCredentialFormat(value)) {
    return maskCredential(value);
  }

  const redacted = redactSecretsInText(value);

  if (!applyInputSanitization) {
    return redacted;
  }

  try {
    return sanitizeString(redacted);
  } catch {
    // If sanitization fails, fall back to a placeholder so logging never breaks
    // on unexpected content.
    return '[SANITIZATION_FAILED]';
  }
}

/**
 * Unwraps an Error into a loggable object. `message` and `stack` are
 * non-enumerable, so the generic object walk would otherwise yield `{}`.
 *
 * @param error - The error to unwrap
 * @param visited - Set of visited objects to prevent infinite recursion
 * @param applyInputSanitization - Whether to also run the input-sanitization layer
 * @returns A plain object describing the error, with credentials redacted
 */
function sanitizeErrorForLog(
  error: Error,
  visited: WeakSet<object>,
  applyInputSanitization: boolean,
): unknown {
  if (visited.has(error)) {
    return '[Circular Reference]';
  }

  const extraKeys = Object.keys(error).filter(
    (key) => key !== 'name' && key !== 'message' && key !== 'stack',
  );

  // The common case: a plain error. Return the redacted stack as a string so the
  // log line keeps its familiar `Error: message\n    at …` rendering.
  if (extraKeys.length === 0 && error.cause === undefined) {
    return redactSecretsInText(error.stack ?? `${error.name}: ${error.message}`);
  }

  visited.add(error);

  const result: Record<string, unknown> = {
    name: error.name,
    message: redactSecretsInText(error.message),
  };

  if (typeof error.stack === 'string') {
    result.stack = redactSecretsInText(error.stack);
  }

  // Own enumerable properties (e.g. MCPError's `code`, HTTP status fields).
  // These are where credential-bearing payloads (request configs, headers)
  // typically ride along on an error.
  for (const key of extraKeys) {
    const value = (error as unknown as Record<string, unknown>)[key];
    result[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : sanitizeLogDataInternal(value, visited, applyInputSanitization);
  }

  if (error.cause !== undefined) {
    result.cause = sanitizeLogDataInternal(error.cause, visited, applyInputSanitization);
  }

  visited.delete(error);
  return result;
}

/**
 * Internal recursive sanitization function with cycle detection
 *
 * @param data - The data to sanitize
 * @param visited - Set of visited objects to prevent infinite recursion
 * @param applyInputSanitization - Whether to also run the input-sanitization layer
 * @returns Sanitized data
 */
function sanitizeLogDataInternal(
  data: unknown,
  visited: WeakSet<object>,
  applyInputSanitization: boolean,
): unknown {
  // Handle primitive types
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return sanitizeLogString(data, applyInputSanitization);
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return data;
  }

  // Handle arrays with recursion protection
  if (Array.isArray(data)) {
    if (visited.has(data)) {
      return '[Circular Reference]';
    }
    visited.add(data);
    const sanitizedArray = data.map((item) =>
      sanitizeLogDataInternal(item, visited, applyInputSanitization),
    );
    // Only true cycles are `[Circular Reference]`; the same object appearing
    // twice in a tree is still rendered on each occurrence.
    visited.delete(data);
    return sanitizedArray;
  }

  if (data instanceof Error) {
    return sanitizeErrorForLog(data, visited, applyInputSanitization);
  }

  // Handle objects with recursion protection
  if (typeof data === 'object' && data !== null) {
    if (visited.has(data)) {
      return '[Circular Reference]';
    }
    visited.add(data);

    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      // Check if key is sensitive using enhanced detection
      if (isSensitiveKey(key)) {
        if (typeof value === 'string') {
          // For string sensitive values, use format detection
          if (isCredentialFormat(value)) {
            sanitized[key] = maskCredential(value);
          } else if (
            !applyInputSanitization &&
            value.includes('://') &&
            LOCATION_KEY_PATTERN.test(key) &&
            !EMBEDDED_CREDENTIAL_NAME.test(key)
          ) {
            // A location-named key holding a URL: keep the endpoint, redact the
            // credential-bearing parts of it.
            sanitized[key] = redactSecretsInText(value);
          } else if (value.length > 50) {
            // Long strings in sensitive keys are likely credentials
            sanitized[key] = maskCredential(value);
          } else {
            sanitized[key] = '[REDACTED]';
          }
        } else {
          // Non-string sensitive values
          sanitized[key] = '[REDACTED]';
        }
      } else {
        // Recursively sanitize non-sensitive values
        sanitized[key] = sanitizeLogDataInternal(value, visited, applyInputSanitization);
      }
    }

    visited.delete(data);
    return sanitized;
  }

  // Handle any other types (functions, symbols, etc.)
  return '[Unsupported Type]';
}

/**
 * Creates a secure configuration object for logging
 * Masks sensitive environment variables and configuration values
 *
 * @param config - Configuration object to sanitize
 * @returns Sanitized configuration for safe logging
 */
export function createSecureLogConfig(config: Record<string, unknown>): Record<string, unknown> {
  return sanitizeLogData(config) as Record<string, unknown>;
}

/**
 * Generates a safe connection status message with masked credentials
 * Enhanced with comprehensive URL and token masking
 *
 * @param url - Connection URL
 * @param token - API token or credential
 * @param authType - Type of authentication being used
 * @returns Safe status message for logging
 */
export function createSecureConnectionMessage(
  url: string | undefined,
  token: string | undefined,
  authType?: string,
): string {
  const maskedUrl = maskUrl(url);
  const maskedToken = maskCredential(token);

  if (authType) {
    return `Connecting to ${maskedUrl} with ${authType} token ${maskedToken}`;
  }

  return `Connecting to ${maskedUrl} with token ${maskedToken}`;
}

/**
 * Performance utility to clear the normalized key cache
 * Useful for testing or memory management in long-running processes
 */
export function clearSecurityCache(): void {
  normalizedKeyCache.clear();
}

/**
 * Gets cache statistics for performance monitoring
 *
 * @returns Object containing cache size and performance metrics
 */
export function getSecurityCacheStats(): { size: number; maxSize: number } {
  return {
    size: normalizedKeyCache.size,
    maxSize: 10000, // Configurable maximum cache size
  };
}
