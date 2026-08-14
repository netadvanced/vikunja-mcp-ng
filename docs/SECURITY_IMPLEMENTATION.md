# Input Sanitization

User-supplied strings that reach Vikunja — task titles and descriptions above
all — pass through a rejection-based sanitization layer in
[`src/utils/validation.ts`](../src/utils/validation.ts). This page documents what
that layer actually blocks, what it deliberately lets through, and which code
paths call it. It is the input-validation half of the security architecture; the
credential-masking half lives in [`src/utils/security.ts`](../src/utils/security.ts)
and is summarized under [Log masking](#log-masking) below.

Every claim here was re-checked against `src/` on 2026-08-03. Where an earlier
version of this document described protections that were never implemented, or
were removed from the code since, the claim has been deleted rather than left
standing — see [What is deliberately not blocked](#what-is-deliberately-not-blocked).

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

- **Time-based and blind attacks** — `WAITFOR DELAY`, `SLEEP(`, `BENCHMARK(`, `DBMS_PIPE.RECEIVE_MESSAGE`
- **Boolean-based blind injection** — `' OR '1'='1`-shaped input. The pattern
  requires a quote immediately after `OR`/`AND` plus an `=` comparison, so
  ordinary prose like "Fix bug or issue" and "Cost or budget = 500" passes.
- **Extended stored procedures** — `XP_*`, `SP_*`

### Command Injection

- **Network and shell commands** — `wget`, `curl`, `nc`, `netcat`, `telnet`, `ssh`, `ftp`, `sftp`
- **Destructive filesystem commands** — `rm -rf`, `del /s`, `format`, `fdisk`, `mkfs`
- **Command substitution** — `$(command)` and `` `command` ``
- **Redirection** — `>/dev/null`, `2>&1`, `||`

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

MongoDB operator patterns `$gt`, `$lt`, `$ne`, `$where`, `$regex` — matched both
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
reason — the destination is a JSON API, not a rendered page.

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
tests, but have **no caller anywhere in `src/`** — production filter parsing and
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

`sanitizeLogData()` in `src/utils/security.ts` composes the two layers. String
values that look like credentials — JWT shape, `tk_*`, `ghp_*`, AWS key IDs,
database URIs, `Bearer`/`Basic` headers, PEM blocks — are replaced by
`maskCredential()` output; everything else is passed through `sanitizeString()`.
If sanitization throws, the value becomes `[SANITIZATION_FAILED]` so a hostile
string can never break logging. Object keys are matched against a sensitive-key
pattern list with Unicode-bypass normalization and a memoization cache.

### Test-Only Methods on AuthManager

`AuthManager` carries two test-only mutators in production code,
`setTestUserId()` and `setTestTokenExpiry()`
([`src/auth/AuthManager.ts:182,197`](../src/auth/AuthManager.ts)). Both call a
private `validateTestEnvironment()` guard first, which throws unless
`JEST_WORKER_ID` is set or `NODE_ENV` is `test` or `development`. The methods
therefore ship in `dist/` but are inert in a production process.

The richer testing surface — `getTestUserId`, `getTestTokenExpiry`,
`updateSessionProperty`, and the `TestableAuthManager` interface and factories —
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
2026-08-03 — the file is exercised well beyond the sanitization suite alone:

```text
File            | % Stmts | % Branch | % Funcs | % Lines
validation.ts   |    90.8 |    78.91 |     100 |   90.49
```

Repo-wide thresholds and the ratcheting policy live in [CLAUDE.md](../CLAUDE.md).

## Performance

Patterns are recompiled per call rather than cached, trading a little throughput
for freedom from `lastIndex` state bugs. Rejection is early — the first matching
pattern throws — so hostile input costs less than clean input.
`security-performance.test.ts` asserts sub-100ms processing for typical inputs.
The sensitive-key normalization cache in `security.ts` is unbounded by design and
exposes `clearSecurityCache()` and `getSecurityCacheStats()` for long-running
processes.

## Standards Mapping

- **OWASP Top 10** — A03 Injection, A05 Security Misconfiguration
- **CWE** — CWE-79 (XSS), CWE-78 (OS command injection), CWE-22 (path traversal),
  CWE-94 (code injection), CWE-1321 (prototype pollution). CWE-89 (SQL injection)
  is addressed **partially and intentionally**: blind and time-based patterns
  only, per [What is deliberately not blocked](#what-is-deliberately-not-blocked).

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md) — where this layer sits in the request path
- [RATE_LIMITING.md](RATE_LIMITING.md) — the DoS-protection half of the middleware story
- [CONFIGURATION.md](CONFIGURATION.md) — secrets handling and the `_FILE` convention
