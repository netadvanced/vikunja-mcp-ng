/**
 * SSO enrollment ticket store (issue #220, docs/OIDC-SETUP.md §"One-click
 * SSO enrollment").
 *
 * An enrollment ticket is the state/CSRF token of the one-click enrollment
 * flow: `vikunja_auth provision` (called by a validated but unprovisioned
 * OIDC identity) mints one, embeds it in the returned enrollment URL
 * (`GET /enroll?ticket=...`), and the same opaque value rides the IdP
 * authorization round trip as the OAuth `state` parameter until
 * `GET /enroll/callback` consumes it exactly once.
 *
 * Properties, each covered by tests/transport/enrollmentTickets.test.ts:
 *  - **Unguessable**: 32 random bytes (`crypto.randomBytes`), base64url.
 *  - **Bound to the initiating identity**: the callback trusts ONLY the
 *    identity stored server-side under the ticket — never anything the
 *    browser sends. This is what keeps a stolen/forged callback from
 *    provisioning someone else's vault slot (D7: identity always comes from
 *    the validated context, never from request input).
 *  - **Short-lived**: TTL enforced on every read (default 10 minutes,
 *    configurable via `enroll.ticketTtlSec`).
 *  - **Single-use**: `consume()` deletes on first success; a replayed
 *    callback gets `null` and a clean error page.
 *  - **One pending enrollment per identity**: re-issuing replaces (and
 *    thereby invalidates) the identity's previous ticket, so the store can
 *    never grow past one live ticket per user...
 *  - **...and never past {@link MAX_PENDING_TICKETS} overall** (DoS guard):
 *    issuing beyond the cap (after sweeping expired entries) throws.
 *
 * Purely in-memory by design: an interrupted enrollment simply expires; the
 * user re-runs `vikunja_auth provision` and gets a fresh link. Nothing here
 * is a durable credential, so nothing needs the vault's encryption or
 * persistence.
 */

import * as crypto from 'node:crypto';
import { identityKey, type Identity } from '../context/requestContext';

/** Global cap on simultaneously-pending tickets (DoS guard, see module doc). */
export const MAX_PENDING_TICKETS = 10_000;

/** Default ticket lifetime: 10 minutes — ample for one IdP round trip. */
export const DEFAULT_TICKET_TTL_MS = 10 * 60 * 1000;

interface TicketRecord {
  readonly identity: Identity;
  readonly issuedAt: number;
}

export class EnrollmentTicketStore {
  private readonly tickets = new Map<string, TicketRecord>();
  /** identityKey -> that identity's single live ticket id. */
  private readonly byIdentity = new Map<string, string>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TICKET_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Mint a fresh ticket for `identity`, replacing (invalidating) any
   * previous pending ticket for the same identity. Throws when the global
   * pending cap is reached even after sweeping expired tickets.
   */
  issue(identity: Identity): string {
    this.sweep();
    const key = identityKey(identity);
    const previous = this.byIdentity.get(key);
    // Cap check BEFORE touching the previous ticket (finding #10): a refused
    // issue must leave the caller's existing pending enrollment fully intact.
    // A replacement (previous exists) never grows the store, so it is always
    // allowed even at the cap.
    if (previous === undefined && this.tickets.size >= MAX_PENDING_TICKETS) {
      throw new Error(
        'Too many pending enrollment tickets — refusing to mint another. ' +
          'Retry after outstanding enrollments complete or expire.',
      );
    }
    if (previous !== undefined) {
      this.tickets.delete(previous);
    }
    const id = crypto.randomBytes(32).toString('base64url');
    this.tickets.set(id, { identity, issuedAt: this.now() });
    this.byIdentity.set(key, id);
    return id;
  }

  /** The identity bound to a live ticket, WITHOUT consuming it (`/enroll` may be hit more than once). */
  peek(id: string): Identity | null {
    const record = this.liveRecord(id);
    return record ? record.identity : null;
  }

  /** Single-use redemption: returns the bound identity and deletes the ticket, or `null`. */
  consume(id: string): Identity | null {
    const record = this.liveRecord(id);
    if (!record) {
      return null;
    }
    this.tickets.delete(id);
    const key = identityKey(record.identity);
    if (this.byIdentity.get(key) === id) {
      this.byIdentity.delete(key);
    }
    return record.identity;
  }

  private liveRecord(id: string): TicketRecord | null {
    const record = this.tickets.get(id);
    if (!record) {
      return null;
    }
    if (this.now() - record.issuedAt > this.ttlMs) {
      this.tickets.delete(id);
      const key = identityKey(record.identity);
      if (this.byIdentity.get(key) === id) {
        this.byIdentity.delete(key);
      }
      return null;
    }
    return record;
  }

  /** Drop every expired ticket (run on each `issue`, keeping the maps bounded). */
  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, record] of this.tickets) {
      if (record.issuedAt < cutoff) {
        this.tickets.delete(id);
        const key = identityKey(record.identity);
        if (this.byIdentity.get(key) === id) {
          this.byIdentity.delete(key);
        }
      }
    }
  }
}
