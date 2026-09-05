# Input Sanitization

User-supplied strings that reach Vikunja (task titles and descriptions above
all) pass through a rejection-based sanitization layer in
[`src/utils/validation.ts`](../src/utils/validation.ts). This page documents what
that layer actually blocks, what it deliberately lets through, and which code
paths call it. It is the input-validation half of the security architecture; the
credential-masking half lives in [`src/utils/security.ts`](../src/utils/security.ts)
and is summarized under [Log masking](#log-masking) below.

Every claim here was re-checked against `src/` on 2026-08-03. Where an earlier
version of this document described protections that were never implemented, or
were removed from the code since, the claim has been deleted rather than left
standing. See [What is deliberately not blocked](#what-is-deliberately-not-blocked).

**The model is rejection, not escaping.** `sanitizeString()` throws
`MCPError(VALIDATION_ERROR, 'String contains potentially dangerous content')` when
input matches any dangerous pattern. Input that passes is returned *normalized*
(Unicode NFC, invisible characters stripped, residual traversal sequences
defanged) but **not** HTML-escaped: this boundary is a JSON REST call to Vikunja,
not an HTML render, so there is nothing to escape for.

## Attack Vector Coverage

Roughly 130 regex patterns, compiled fresh on each call to avoid `lastIndex`
state bugs with the `g` flag.

### Cross-Site Scripting

| Vector | Blocked |
|---|---|
| Script and frame tags | `<script>`, `</script>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<style>` |
| SVG | `<svg>`, `</svg>` |
| Event handlers | ~39 named handlers (`onclick`, `onload`, `onerror`, `onmouseover` … `onwaiting`) plus a generic `on\w+ = "…"` attribute pattern |
| Tags carrying handlers | `<img … on…>`, `<div … on…>`, `<a … on…>`, `<body … on…>`, `<form … on…>`, `<input … on…>`, `<button … on…>`, `<select … on…>`, `<textarea … on…>` |
| Dangerous protocols | `javascript:`, `vbscript:` |
| Data URLs | `data:text/html`, `data:application/javascript`, `data:text/javascript`, `data:text/vbscript`, `data:application/x-javascript` |
| CSS injection | `expression(`, `@import`, `url(`, `binding:`, `behavior:`, `-moz-binding:`, `-o-link:`, `-webkit-binding:` |
| HTML5 attributes | `formaction=`, `poster=`, `autofocus=`, `controls=`, `autoplay=`, `loop=`, `muted=` |
| HTML comments | `<!--` |
| HTML-encoded equivalents | `&lt;script&gt;`, `&lt;iframe…&gt;`, `&lt;svg…&gt;`, `&lt;img … on…&gt;`, encoded comments |

### SQL Injection

Narrow by design (see [What is deliberately not blocked](#what-is-deliberately-not-blocked)):

- **Time-based and blind attacks**: `WAITFOR DELAY`, `SLEEP(`, `BENCHMARK(`, `DBMS_PIPE.RECEIVE_MESSAGE`
- **Boolean-based blind injection**: `' OR '1'='1`-shaped input. The pattern
  requires a quote immediately after `OR`/`AND` plus an `=` comparison, so
  ordinary prose like "Fix bug or issue" and "Cost or budget = 500" passes.
- **Extended stored procedures**: `XP_*`, `SP_*`

### Command Injection

- **Network and shell commands**: `wget`, `curl`, `nc`, `netcat`, `telnet`, `ssh`, `ftp`, `sftp`
- **Destructive filesystem commands**: `rm -rf`, `del /s`, `format`, `fdisk`, `mkfs`
- **Command substitution**: `$(command)` and `` `command` ``
- **Redirection**: `>/dev/null`, `2>&1`, `||`

### Path Traversal

- `../` and `..\`
- URL-encoded forms `%2e%2e/`, `%2e%2e%2f`, `%2e%2e%5c`
- System paths `/etc/passwd`, `/etc/shadow`, `/proc/`
- Windows paths `c:\windows\system32`, `\..\`

Sequences that survive rejection are additionally defanged on the accepted path:
`../` becomes `...`, `/etc/passwd` becomes `etc/passwd`, and backslashes in
`c:\windows\system32` are normalized to forward slashes.

### LDAP Injection

Filter-manipulation constructs: `*)(&`, `*)(…*)`, `(|(…)|)`, `(!(…))`.

### NoSQL Injection

MongoDB operator patterns `$gt`, `$lt`, `$ne`, `$where`, `$regex`, matched both
raw (`$gt:`) and as quoted JSON keys (`"$gt":`), so `JSON.stringify` output does
not slip past.

### Unicode and Encoding Bypasses

- Zero-width and invisible characters `\u200b`–`\u200f`, `\u2060`, `\u180e`, `\ufeff`
- Variation selectors `\uFE00`–`\uFE0F`
- Escape sequences `\uXXXX`, `\xXX`
- NFC normalization applied before the value is returned

### Prototype Pollution

- `__proto__`, `constructor`, `prototype` rejected as string content and as field names
- `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__` rejected as field names and skipped during object copying
- `safeJsonParse()` pre-scans the raw JSON string for pollution patterns before `JSON.parse` runs
- `createSafeObjectCopy()` rebuilds objects without a prototype chain

### Content Security Policy Vectors

`eval(`, `Function(`, `setTimeout(`, `setInterval(`, `atob(`, `btoa(`,
`document.write`/`writeln`/`open`/`close`, `window.open`/`location`/`navigate`.

## What Is Deliberately Not Blocked

Earlier versions of this document claimed protections that do not exist in the
code. They are absent on purpose, and re-adding them would break ordinary user
content.

**Bare SQL keywords are allowed.** There is no pattern matching `SELECT`,
`INSERT`, `UPDATE`, `DELETE`, `DROP` or `UNION` on its own, no `--` / `#` /
`/* */` comment detection, and no `INFORMATION_SCHEMA` / `SYS` / `MASTER` object
blocking. Task titles are prose; "Update the deploy docs" is not an attack.

**The broad shell-metacharacter blocklist was removed.** The old character list
(`;` `&` `|` backtick `$` `(){}[]` quotes `*?<>~`) rejected any string containing
a bare quote or angle bracket. Generic non-scripting HTML-like text
(`<div class="x">`) now passes through unmodified; only constructs with an actual
scripting or DOM-execution vector are rejected. See the explanatory comment at
`src/utils/validation.ts:203-210`.

**No HTML entity encoding is applied.** Removed in `f2b0b93` for the same
reason: the destination is a JSON API, not a rendered page.

The residual accepted here is that input which merely *mentions* SQL keywords or
shell metacharacters reaches Vikunja as data. That is safe at a JSON REST
boundary and is not a gap to be closed by re-broadening the patterns.

## Implementation

### Exported Surface

`src/utils/validation.ts` (~980 lines):

| Function | Purpose |
|---|---|
| `sanitizeString(value)` | Main entry point. Rejects dangerous content, normalizes the rest. Enforces `MAX_STRING_LENGTH` of 1000. |
| `validateId(id, fieldName)` / `validateAndConvertId(id, fieldName)` | Positive-integer ID validation and coercion |
| `validateValue(value)` | Array/scalar validation; max 100 elements, type-consistent, each string element run through `sanitizeString` |
| `safeJsonStringify(obj)` / `safeJsonParse(str)` | Filter-expression serialization with pollution guards; 50 000-character parse cap |
| `validateField` / `validateOperator` / `validateLogicalOperator` / `validateCondition` / `validateFilterExpression` | Zod-backed filter-expression validation with DoS bounds (`MAX_NESTING_DEPTH` 10, `MAX_CONDITIONS` 50) |

**Only three of these are wired into production code paths.** Grepping `src/`
for imports from `utils/validation` returns `sanitizeString`, `validateId` and
`validateAndConvertId` and nothing else. `validateValue`, `safeJsonStringify`,
`safeJsonParse` and the filter-expression validators are exported and covered by
tests, but have **no caller anywhere in `src/`**. Production filter parsing and
validation goes through [`src/utils/filters.ts`](../src/utils/filters.ts)
(`parseFilterString`, `SecurityValidator`, its own Zod schemas) instead. Treat
them as available primitives, not as active defenses.

### Call Sites

| Location | What is sanitized |
|---|---|
| [`src/tools/tasks/crud/TaskCreationService.ts:72-75`](../src/tools/tasks/crud/TaskCreationService.ts) | Task `title` and `description` on create |
| [`src/tools/tasks/subtasks.ts:310-312,503-504`](../src/tools/tasks/subtasks.ts) | Subtask `title` and `description`, including the bulk-create path |
| [`src/utils/security.ts:295`](../src/utils/security.ts) | Every non-credential string passing through `sanitizeLogData` |

### Log Masking

**Redaction happens centrally, inside `src/utils/logger.ts`, not at each call
site.** `Logger.log()` runs every argument through `sanitizeLogArgs()` (from
`src/utils/security.ts`), then runs the fully rendered message string through
`redactSecretsInText()` as a textual backstop, and only then writes the line,
all of it *after* the level gate, so a suppressed level (e.g. `logger.debug`
when `LOG_LEVEL` is `info`) costs nothing: nothing is cloned, walked, or
scanned. This closed a real leak (PR #241, `fix/logger-credential-redaction`):
webhook `secret` and `targetUrl` values were being written to `logger.error`
calls verbatim, and ERROR is the level emitted by default with no
configuration at all, which is the exact production configuration every
deployment starts in. Because the fix is centralized in the logger, individual call
sites (webhook error handlers included) no longer need to remember to strip
their own credentials before logging. The previous model, where every call
site was independently responsible for that, is exactly what let the leak
through in the first place.

**Two sanitizers, deliberately not one.** `src/utils/security.ts` exports
both, and they exist separately on purpose:

| Function | Used by | Behavior |
|---|---|---|
| `sanitizeLogData()` | Config serialization (`createSecureLogConfig`) | **Strict**: after credential masking, every remaining string is also run through the input-sanitization layer (`sanitizeString()`), which *rejects* content that looks dangerous. |
| `sanitizeForLogging()` (and `sanitizeLogArgs()`, which maps it over a call's variadic args) | `Logger.log()` for every log line | **Log-safe**: the same credential masking, minus the rejection layer. |

Wiring `sanitizeLogData` (the strict one) directly into the logger was tried
and rejected: stderr is not an HTML sink, so the injection-rejection behavior
buys no security there, while it actively breaks ordinary diagnostics: an
`Error` object has non-enumerable `message`/`stack` properties, so a strict
generic object walk reduces it to `{}`; and any string over `MAX_STRING_LENGTH`
(1000 characters, routine for a stack trace or a large payload) becomes the
literal string `[SANITIZATION_FAILED]` instead of the diagnostic it was
supposed to be. `sanitizeForLogging()` keeps the credential masking but drops
that rejection layer, and additionally unwraps `Error` instances into a plain
`{name, message, stack, ...ownProps}` object first so nothing is lost to the
non-enumerable-property problem.

**What redaction catches, beyond matching on key names.** Sensitive object
keys (`secret`, `token`, `password`, `apiKey`, `user`, `email`, and similar;
see `SENSITIVE_KEY_PATTERNS` in `src/utils/security.ts`) are replaced with
`[REDACTED]`, or with `maskCredential()`'s masked-prefix form when the value
itself is long or recognizably credential-shaped (JWT, `tk_*`, `ghp_*`, AWS
key IDs, database URIs, `Bearer`/`Basic` headers, PEM blocks). Beyond key-name
matching, `redactSecretsInText()` (the textual backstop applied to every
rendered log line, and reused directly by the structural pass wherever a
sensitive value is itself a URL) additionally catches:

- **Secrets embedded in a URL path** (e.g. a Slack incoming-webhook URL,
  whose last path segment *is* the credential)
- **URL userinfo** (`https://user:pass@host/...`)
- **Sensitive query-string values** (`?token=...`, `?api_key=...`)
- **Credentials embedded in prose**, not just structured fields: a
  `name=value`-shaped substring inside a plain message string, where the name
  reads as a credential

These are exactly the shapes a key-name-only check misses: a webhook
`targetUrl` is not itself a "secret" field, but the credential can live
inside the URL string it holds.

**This masking is not only a logging concern.** Since issue #327,
`vikunja_webhooks`' `redactWebhookCredentials` (`src/tools/webhooks.ts`) applies this
same URL-secret detection (`redactUrlSecrets`) to `target_url` in every `list`/`get`/
`create`/`update` **tool response**, not just log lines — a secret-bearing webhook URL
used to round-trip in full every time a caller listed or fetched the webhook again.



**Operator-visible consequence.** Some fields that previously rendered in
full now render as `[REDACTED]` in log output, most notably `user`. This is
intentional (the field name matches the sensitive-key patterns tuned for
credential-adjacent identifiers), not a bug; if a deployment relies on `user`
appearing in logs for auditing, do not work around this by re-broadening the
call site. File it as a redaction-policy question instead.

**A cycle-detection fix rode along in the same PR.** The recursive sanitizer
tracks visited objects in a `WeakSet` to guard against infinite recursion on
a truly cyclic object. Before PR #241, the same *non-cyclic* object appearing
twice in a tree (e.g. the same error object nested at two different keys) was
incorrectly reported as `[Circular Reference]`, because the visited-set entry was
never removed after finishing that branch. It is now removed once a
branch's traversal completes, so only genuine cycles are collapsed; the same
object appearing twice in a non-cyclic tree is rendered in full at each
occurrence.

### Error and Response Redaction

Log masking (above) covers `Logger.log()` only. The other way text leaves this
server is the MCP response itself, and until the fix described here that
surface had no redaction at all. Three separate gaps, all found by the
2026-08-31 audit (issues #287 and #292):

**1. Thrown-error text now goes through the same redaction pass as logs.**
`SecureErrorHandler.sanitize()` in `src/utils/error-handler.ts` recognized a
fixed list of *categories* (stack traces, database URIs, IP addresses, file
paths) and replaced the whole message with a canned string when one matched.
None of those categories covers a bare credential, so a raw `eyJ...` JWT, a
PEM block, or a webhook URL with the secret in its path travelled verbatim
into `MCPError.message` and out to the MCP client. `sanitize()` now ends with
`redactSecretsInText()`, the same function the logger uses, so there is one
definition of what a secret looks like across logs and errors. It runs last
and replaces only the credential substring, so messages that already matched a
category keep their canned text and ordinary messages stay readable.

**2. The sanitizer's shared regexes are no longer stateful.**
`SECURITY_PATTERNS` is a module-level array shared by every call, and its
entries were declared with the `g` flag while being used with `.test()`. A
global regex carries a mutable `lastIndex`, so a match in one call made the
next call resume scanning from that offset: a shorter follow-up message got no
match and was returned unsanitized. In `oidc-http` mode a single process
serves many identities, which turned this into a cross-request leak of one
caller's raw error text into another caller's response. The patterns are now
non-global, which makes `.test()` stateless. The regression test
(`tests/utils/error-redaction.test.ts`) drives two sequential "requests"
through the shared singleton and asserts the second is sanitized identically
whether or not the first ran. **Rule for anyone editing that array: do not add
`g` or `y` to a shared regex that is used with `.test()`.**

**3. Upstream HTTP error bodies are redacted before they reach the message.**
`src/utils/vikunja-rest.ts` interpolates the first 500 characters of a failed
response body into `MCPError.message`. That body is authored by something this
server does not control: Vikunja itself, but also any reverse proxy, WAF, or
auth gateway in front of it, and those routinely echo request details back,
including the `Authorization` header or a query string. The body now runs
through `redactSecretsInText()` before truncation (the scan covers 4 KiB so a
credential straddling the 500-character display cut cannot have its tail
trimmed off and its head kept), and the message of a failure thrown by `fetch`
itself gets the same treatment, since it embeds the request URL and can
therefore carry userinfo credentials. `redactSecretsInText()` gained a rule
for quoted `"name": "value"` pairs at the same time, because error bodies are
usually JSON and the pre-existing prose rule wanted the `:` to sit directly
after the name.

**One deliberate exception: `vikunja_projects auth-share`.** This subcommand
returns a live share-scoped JWT in its response, in full. That is the point of
the operation rather than a leak: `POST /shares/{hash}/auth` is a credential
exchange, and the caller trades a share hash plus the share's password for the
bearer token every later read of the shared project needs. The token is the
caller's own, minted in that request from a secret they supplied in the same
call, so it is not a cross-identity exposure even in `oidc-http` mode, and its
scope and lifetime are narrower than the session credential the caller already
holds. The decision is documented at the call site in
`src/tools/projects/sharing.ts` and pinned by a test named for it in
`tests/tools/projects/sharing.test.ts`, so a future response-hardening sweep
has to change it deliberately rather than silently break share auth.

### Test-Only Methods on AuthManager

`AuthManager` carries two test-only mutators in production code,
`setTestUserId()` and `setTestTokenExpiry()`
([`src/auth/AuthManager.ts:182,197`](../src/auth/AuthManager.ts)). Both call a
private `validateTestEnvironment()` guard first, which throws unless
`JEST_WORKER_ID` is set or `NODE_ENV` is `test` or `development`. The methods
therefore ship in `dist/` but are inert in a production process.

The richer testing surface (`getTestUserId`, `getTestTokenExpiry`,
`updateSessionProperty`, and the `TestableAuthManager` interface and factories)
lives entirely in `tests/utils/test-utils.ts`, monkey-patched onto instances at
test time, and is never shipped.

A 2025-08-18 audit report inherited from upstream claimed all five methods had
been relocated out of `AuthManager` into dedicated `src/auth/` modules. That
never happened in this repository; the paragraph above reflects what's actually
true instead. Moving the two remaining mutators into `tests/utils/test-utils.ts`
alongside the others is a small, unclaimed cleanup.

## Testing

[`tests/utils/input-sanitization.test.ts`](../tests/utils/input-sanitization.test.ts)
holds 40 tests across 12 groups:

| Group | Tests |
|---|---|
| XSS Protection in Task Content | 10 |
| SQL Injection Protection in Filter Values | 4 |
| Command Injection Protection | 4 |
| Path Traversal Protection | 2 |
| LDAP Injection Protection | 2 |
| NoSQL Injection Protection | 2 |
| HTML Attribute Sanitization | 3 |
| Unicode and Encoding Attack Protection | 3 |
| Content Security Policy Integration | 2 |
| JSON Security | 3 |
| Array and Bulk Operation Security | 3 |
| Integration with Existing Security | 2 |

Related suites: `security.test.ts`, `security-integration.test.ts`,
`security-vulnerability.test.ts`, `security-performance.test.ts`,
`filters-security.test.ts`, `filters-redos-security.test.ts`.

Coverage of `src/utils/validation.ts` measured across the full suite on
2026-08-03; the file is exercised well beyond the sanitization suite alone:

```text
File            | % Stmts | % Branch | % Funcs | % Lines
validation.ts   |    90.8 |    78.91 |     100 |   90.49
```

Repo-wide thresholds and the ratcheting policy live in [CLAUDE.md](../CLAUDE.md).

## Performance

Patterns are recompiled per call rather than cached, trading a little throughput
for freedom from `lastIndex` state bugs. Rejection is early (the first matching
pattern throws), so hostile input costs less than clean input.
`security-performance.test.ts` asserts sub-100ms processing for typical inputs.
The sensitive-key normalization cache in `security.ts` is unbounded by design and
exposes `clearSecurityCache()` and `getSecurityCacheStats()` for long-running
processes.

## Standards Mapping

- **OWASP Top 10**: A03 Injection, A05 Security Misconfiguration
- **CWE**: CWE-79 (XSS), CWE-78 (OS command injection), CWE-22 (path traversal),
  CWE-94 (code injection), CWE-1321 (prototype pollution). CWE-89 (SQL injection)
  is addressed **partially and intentionally**: blind and time-based patterns
  only, per [What is deliberately not blocked](#what-is-deliberately-not-blocked).

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md): where this layer sits in the request path
- [RATE_LIMITING.md](RATE_LIMITING.md): the DoS-protection half of the middleware story
- [CONFIGURATION.md](CONFIGURATION.md): secrets handling and the `_FILE` convention
