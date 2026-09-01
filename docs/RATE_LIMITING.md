# Rate Limiting and Request Size Controls

The rate limiting and request-size control system protects the server against DoS
patterns and resource exhaustion: **request flooding** (per-minute and per-hour request
caps), **large payload attacks** (request and response size validation),
**long-running operations** (per-category execution timeouts), and **resource
exhaustion** generally. Every limit is tunable through environment variables, listed
below and mirrored in [CONFIGURATION.md § Rate Limiting Variables](CONFIGURATION.md).

## Architecture

The system consists of three main components:

1. **`SecureRateLimitMiddleware`** (`src/middleware/simplified-rate-limit.ts`) - Core rate
   limiting logic, backed by `express-rate-limit`'s `MemoryStore` (fixed-window counters
   for the 60s and 3600s windows) with an `opossum` circuit breaker in front of the store
   and a mutex around the check/increment critical section. Exported under the
   back-compat aliases `RateLimitingMiddleware` / `SimplifiedRateLimitMiddleware` and the
   singletons `rateLimitingMiddleware` / `simplifiedRateLimitMiddleware` /
   `secureRateLimitMiddleware`.
2. **Central registration wrapper** (`src/middleware/tool-rate-limit.ts`) -
   `withRateLimitedTools(server)`, applied in `registerTools` **only when the server is
   running in `oidc-http` transport mode** (one process, many identities, so rate limits
   contain a noisy neighbour per `docs/ROADMAP.md` decision 16(c)). Every `server.tool(...)`
   call made through the returned view has its handler wrapped, so the whole registered tool
   surface is metered per identity without touching 27 call sites (#263). **The default
   `stdio` deployment never applies this wrapper**: one process serves exactly one identity
   there, so there is no noisy neighbour to contain, and the epic's hard invariant
   (`docs/OIDC-RESOURCE-SERVER.md` §2, `src/index.ts`'s transport-mode doc comment) requires
   `stdio` to stay byte-for-byte its pre-OIDC-epic behavior. A `stdio` deployment is
   therefore unmetered regardless of `RATE_LIMIT_ENABLED`/`RATE_LIMIT_PER_MINUTE` below;
   those variables only take effect once `oidc-http` mode is selected.
3. **Direct middleware helpers** (`src/middleware/direct-middleware.ts`) - `applyRateLimiting`
   / `applyPermissions` / `applyBothMiddleware`, the opt-in per-tool integration layer
4. **Configuration System** - Environment-based configuration with sensible defaults

### Design Principles

- **Non-intrusive** - Minimal changes to existing tool implementations
- **Configurable** - All limits adjustable via environment variables
- **Tool-aware** - Different limits for different tool categories
- **Session-based** - Per-session tracking with in-memory storage
- **Graceful degradation** - Clear error messages when limits exceeded

## Configuration

### Environment Variables

All rate limiting is controlled via environment variables with sensible defaults:

#### Global Settings
```bash
# Enable/disable rate limiting (default: true)
RATE_LIMIT_ENABLED=true
```

#### Default Tool Limits
```bash
# Requests per minute (default: 60)
RATE_LIMIT_PER_MINUTE=60

# Requests per hour (default: 1000) 
RATE_LIMIT_PER_HOUR=1000

# Maximum request size in bytes (default: 1MB)
MAX_REQUEST_SIZE=1048576

# Maximum response size in bytes (default: 10MB)
MAX_RESPONSE_SIZE=10485760

# Tool execution timeout in milliseconds (default: 30 seconds)
TOOL_TIMEOUT=30000
```

#### Expensive Tool Limits
For computationally expensive operations:
```bash
EXPENSIVE_RATE_LIMIT_PER_MINUTE=10
EXPENSIVE_RATE_LIMIT_PER_HOUR=100
EXPENSIVE_MAX_REQUEST_SIZE=2097152    # 2MB
EXPENSIVE_MAX_RESPONSE_SIZE=52428800  # 50MB
EXPENSIVE_TOOL_TIMEOUT=120000         # 2 minutes
```

#### Bulk Operation Limits
For bulk import/export operations:
```bash
BULK_RATE_LIMIT_PER_MINUTE=5
BULK_RATE_LIMIT_PER_HOUR=50
BULK_MAX_REQUEST_SIZE=5242880         # 5MB
BULK_MAX_RESPONSE_SIZE=104857600      # 100MB
BULK_TOOL_TIMEOUT=300000              # 5 minutes
```

#### Export Operation Limits
For data export operations:
```bash
EXPORT_RATE_LIMIT_PER_MINUTE=2
EXPORT_RATE_LIMIT_PER_HOUR=10
EXPORT_MAX_REQUEST_SIZE=1048576       # 1MB
EXPORT_MAX_RESPONSE_SIZE=1073741824   # 1GB
EXPORT_TOOL_TIMEOUT=600000            # 10 minutes
```

### Tool Categories

Tools are automatically categorized for rate limiting:

| Category | Tools | Characteristics |
|----------|-------|-----------------|
| `default` | `vikunja_auth`, `vikunja_tasks`, `vikunja_projects`, `vikunja_labels`, `vikunja_teams`, `vikunja_users`, `vikunja_filters`, `vikunja_templates`, `vikunja_webhooks`, the `vikunja_task_*` sub-resource tools, `vikunja_notifications`, `vikunja_subscriptions`, `vikunja_reactions`, `vikunja_tokens`, `vikunja_caldav_tokens`, `vikunja_admin`, `vikunja_user_deletion`, `vikunja_user_export_status` | Standard CRUD operations |
| `bulk` | `vikunja_batch_import`, `vikunja_task_bulk` | High-volume data operations |
| `export` | `vikunja_export_project`, `vikunja_request_user_export`, `vikunja_download_user_export` (plus the legacy names `vikunja_export`, `vikunja_export_tasks`, `vikunja_export_projects`) | Large data exports |

The table mirrors `TOOL_CATEGORIES` in `src/middleware/simplified-rate-limit.ts`.
Caveats worth knowing before relying on it:

- The `expensive` profile has configurable limits (see the env vars above) but **no tool
  is mapped to it** — nothing in `TOOL_CATEGORIES` uses that category today.
- An unmapped tool name still falls through to `default`. Since #263 that should not
  happen for a registered tool: `tests/middleware/tool-rate-limit.test.ts` asserts every
  name `registerTools` registers has an explicit entry, so a new tool that forgets one
  fails the suite rather than silently inheriting the default budget.
- `vikunja_user_export_status` is deliberately `default`, not `export`: it only reads
  whether a previously requested export is ready, and the export category's
  2-requests-per-minute budget would make the honest ask-wait-ask-again pattern trip the
  limiter.

## Implementation

### Integrating Rate Limiting

Rate limiting is applied by wrapping a tool's handler before handing it to
`server.tool(...)`. **You do not have to do this per tool.** `registerTools`
(`src/tools/index.ts`) registers every tool through a rate-limiting view of the
`McpServer` (`withRateLimitedTools`, `src/middleware/tool-rate-limit.ts`), which wraps the
handler of every `server.tool(...)` call made through it, keyed by the tool name that call
already passes. A registered tool is therefore metered by construction, and adding a new
tool needs no rate-limiting code at all — only an entry in `TOOL_CATEGORIES` picking its
budget.

> This is a fix, not the original design. Until #263 only `src/tools/auth.ts` wrapped its
> handler, so every other tool ran unmetered per identity — which in `oidc-http` mode
> (one process serving many accounts) is what `docs/ROADMAP.md` decision 16(c) assumed
> was *not* the case when it accepted sharing circuit breakers across tenants.

Two consequences of the limits now applying everywhere, worth knowing before tuning:

- **Execution timeouts are live for every tool.** A `default`-category tool is cut off at
  `TOOL_TIMEOUT` (30s by default); `bulk` gets 5 minutes and `export` 10. If a legitimately
  slow operation starts reporting `TIMEOUT_ERROR`, raise the category's timeout rather than
  disabling the guard. On timeout the in-flight HTTP request is now genuinely aborted
  (#296 LOW-20), and the error says so: whether the server already applied the change is
  unknown, so re-check before retrying rather than blindly re-sending.
- **Response-size guards are live for every tool** at `MAX_RESPONSE_SIZE` (10MB by
  default) for the `default` category.

The per-tool helpers below remain supported for a tool that wants to opt in explicitly;
the central wrapper detects an already-wrapped handler and leaves it alone rather than
charging the call twice.

#### Wrapping a Tool Handler
```typescript
import { applyRateLimiting } from '../middleware/direct-middleware';

server.tool(
  'my_tool_name',
  {
    subcommand: z.enum(['create', 'read', 'update', 'delete']),
    // ... other schema fields
  },
  applyRateLimiting('my_tool_name', async (args) => {
    // Tool implementation
    return { success: true };
  }),
);
```

#### Rate Limiting + Permission Checks Together
```typescript
import { applyBothMiddleware } from '../middleware/direct-middleware';

server.tool('my_tool_name', schema, applyBothMiddleware('my_tool_name', authManager, handler));
```

#### Direct Handler Wrapping
```typescript
import { withRateLimit } from '../middleware/simplified-rate-limit';

const handler = async (args) => {
  // Tool logic
};

const rateLimitedHandler = withRateLimit('tool_name', handler);
```

### Custom Rate Limiting
```typescript
import { RateLimitingMiddleware } from '../middleware/simplified-rate-limit';

const customMiddleware = new RateLimitingMiddleware({
  default: {
    requestsPerMinute: 100,
    requestsPerHour: 2000,
    maxRequestSize: 2097152, // 2MB
    maxResponseSize: 20971520, // 20MB
    executionTimeout: 60000, // 1 minute
    enabled: true,
  },
});

const wrappedHandler = customMiddleware.withRateLimit('my_tool', handler);
```

## Error Responses

When rate limits are exceeded, the system returns structured error responses:

### Rate Limit Exceeded
```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded: 60/60 requests per minute",
    "details": {
      "rateLimitType": "per_minute",
      "limit": 60,
      "current": 60,
      "resetTime": 45
    }
  }
}
```

### Request Too Large
```json
{
  "error": {
    "code": "REQUEST_TOO_LARGE", 
    "message": "Request size 2048000 bytes exceeds limit of 1048576 bytes",
    "details": {
      "requestSize": 2048000,
      "maxRequestSize": 1048576
    }
  }
}
```

### Timeout Error
```json
{
  "error": {
    "code": "TIMEOUT_ERROR",
    "message": "Tool execution timeout after 30000ms",
    "details": {
      "timeout": 30000,
      "toolName": "vikunja_tasks"
    }
  }
}
```

## Monitoring and Debugging

### Rate Limit Status
```typescript
import { rateLimitingMiddleware } from '../middleware/simplified-rate-limit';

// Async variant reads the real counts from MemoryStore; the sync
// getRateLimitStatus() always reports 0 for the two request counters.
const status = await rateLimitingMiddleware.getRateLimitStatusAsync();
console.log({
  sessionId: status.sessionId,
  requestsLastMinute: status.requestsLastMinute,
  requestsLastHour: status.requestsLastHour,
  limits: status.limits
});
```

### Clearing Session Data
```typescript
// Clear the CALLING identity's counters (every category, minute and hour
// buckets). Other identities are untouched, and the circuit breakers — which
// are process-wide, not per-identity — are left alone.
await rateLimitingMiddleware.clearSession();

// Clear one specific identity's counters. In oidc-http mode the session id
// is the identity key, "<issuer>|<sub>"; in stdio mode it is
// `session_${process.pid}`.
await rateLimitingMiddleware.clearSession('https://idp.example/realm|user-a');

// Testing escape hatch: reset EVERY identity's counters and both circuit
// breakers.
await rateLimitingMiddleware.clearAll();
```

> Before #296 (LOW-18) `clearSession` ignored its argument and behaved like
> `clearAll()`. It had no callers, but "reset this user" silently meaning "reset
> every tenant in the process" was a cross-tenant bug waiting for its first caller.

### Configuration Inspection
```typescript
const config = rateLimitingMiddleware.getConfig();
console.log('Current rate limiting configuration:', config);
```

## Testing

### Unit Tests
```bash
# Run rate limiting tests
npm test tests/middleware/rate-limiting.test.ts

# Window rotation, per-identity clearSession, deadline cancellation (#263, #296)
npm test tests/middleware/rate-limit-windows.test.ts

# The central registration wrapper: every registered tool is metered (#263)
npm test tests/middleware/tool-rate-limit.test.ts

# Run integration tests  
npm test tests/integration/rate-limiting-integration.test.ts
```

### Testing with Disabled Rate Limiting
```bash
# Disable for testing
RATE_LIMIT_ENABLED=false npm test

# Or set very high limits
RATE_LIMIT_PER_MINUTE=10000 npm test
```

### Load Testing
```typescript
// Example load test
describe('Load Testing', () => {
  it('should handle burst requests gracefully', async () => {
    const promises = Array.from({ length: 100 }, () => 
      wrappedHandler({ test: 'data' })
    );
    
    const results = await Promise.allSettled(promises);
    const successful = results.filter(r => r.status === 'fulfilled');
    const rateLimited = results.filter(r => 
      r.status === 'rejected' && 
      r.reason.code === 'RATE_LIMIT_EXCEEDED'
    );
    
    expect(successful.length).toBeLessThanOrEqual(60); // Per minute limit
    expect(rateLimited.length).toBeGreaterThan(0);
  });
});
```

## Security Considerations

### Session Management
- In `oidc-http` mode a session is the validated caller identity, `"<issuer>|<sub>"`, so
  each account gets its own bucket. In `stdio` mode (single-tenant) there is no identity
  context and the bucket falls back to the process, `session_${process.pid}`.
- In-memory storage (no persistent tracking across restarts)
- Counters expire on fixed 60s / 3600s windows held by `express-rate-limit`'s
  `MemoryStore`. The store is given its window length via `init()` at construction —
  omitting that (the pre-#263 state) leaves `windowMs` undefined, which makes every
  bucket's reset time `NaN` and stops the windows rotating at all, turning "60 per minute"
  into 60 per process lifetime.

### Attack Mitigation
- **Burst protection** - Per-minute window caps quick bursts
- **Sustained attack protection** - Hourly limits prevent long-term abuse  
- **Memory protection** - Request/response size limits prevent memory exhaustion
- **CPU protection** - Execution timeouts prevent resource monopolization

### Production Deployment
```bash
# Recommended production settings
RATE_LIMIT_PER_MINUTE=30
RATE_LIMIT_PER_HOUR=500
MAX_REQUEST_SIZE=524288        # 512KB
MAX_RESPONSE_SIZE=5242880      # 5MB
TOOL_TIMEOUT=15000             # 15 seconds

# For high-traffic scenarios
EXPENSIVE_RATE_LIMIT_PER_MINUTE=5
BULK_RATE_LIMIT_PER_MINUTE=2
EXPORT_RATE_LIMIT_PER_MINUTE=1
```

## Performance Impact

### Minimal Overhead
- **Memory**: ~100 bytes per session for tracking
- **CPU**: O(1) rate limit checks with periodic O(n) cleanup
- **Latency**: <1ms overhead per request

### Scaling Considerations
- In-memory storage limits horizontal scaling
- For distributed deployments, consider Redis-based session storage
- Counter cleanup is delegated to `MemoryStore`'s own TTL handling — there is no
  additional cleanup timer in this codebase

## Troubleshooting

### Common Issues

#### Rate Limits Too Strict
```bash
# Check current limits (run `npm run build` first — this reads the compiled output)
node -e "console.log(require('./dist/middleware/simplified-rate-limit').rateLimitingMiddleware.getConfig())"

# Increase limits temporarily
RATE_LIMIT_PER_MINUTE=120 npm start
```

#### Timeouts on Legitimate Operations
```bash
# Increase timeout for specific operations
TOOL_TIMEOUT=60000 npm start

# Or disable for debugging
RATE_LIMIT_ENABLED=false npm start
```

#### Large Response Sizes
```bash
# Check response size limits
MAX_RESPONSE_SIZE=20971520 npm start  # 20MB

# Monitor actual response sizes in logs
DEBUG=true npm start
```

### Debugging Tips
1. Enable debug logging: `DEBUG=true`
2. Monitor rate limit status in tool handlers
3. Use integration tests to verify limits
4. Check environment variable loading
5. Verify tool category mappings

## Future Enhancements

### Planned Features
- **Redis backend** - Distributed rate limiting
- **Per-user limits** - User-specific rate limiting
- **Dynamic limits** - Adjust limits based on server load
- **Metrics export** - Prometheus/CloudWatch integration
- **Rate limit headers** - HTTP-style rate limit information

### Contributing
When adding new tools:
1. Categorize the tool appropriately in `TOOL_CATEGORIES`
2. Wrap the handler with `applyRateLimiting` (or `applyBothMiddleware`) at registration
3. Add integration tests
4. Document any special rate limiting needs