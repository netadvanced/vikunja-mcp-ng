/**
 * Unit tests for the SSO enrollment ticket store (issue #220).
 *
 * Tickets are the state/CSRF half of the one-click enrollment flow: an
 * unguessable, short-lived, single-use handle minted for a validated OIDC
 * identity by `vikunja_auth provision`, carried through the IdP round trip as
 * the OAuth `state` parameter, and consumed exactly once by
 * `GET /enroll/callback`.
 */

import {
  EnrollmentTicketStore,
  MAX_PENDING_TICKETS,
} from '../../src/transport/enrollmentTickets';
import type { Identity } from '../../src/context/requestContext';

const alice: Identity = { issuer: 'https://idp.example.test/realms/e', sub: 'alice' };
const bob: Identity = { issuer: 'https://idp.example.test/realms/e', sub: 'bob' };

describe('EnrollmentTicketStore', () => {
  it('issues an unguessable, URL-safe ticket id', () => {
    const store = new EnrollmentTicketStore();
    const id = store.issue(alice);
    expect(id).toMatch(/^[A-Za-z0-9_-]{40,}$/); // base64url, >= 240 bits
    const other = store.issue(bob);
    expect(other).not.toBe(id);
  });

  it('peek returns the bound identity without consuming the ticket', () => {
    const store = new EnrollmentTicketStore();
    const id = store.issue(alice);
    expect(store.peek(id)).toEqual(alice);
    // Peeking twice still works — the IdP hop may retry /enroll.
    expect(store.peek(id)).toEqual(alice);
    // And the ticket is still consumable afterwards.
    expect(store.consume(id)).toEqual(alice);
  });

  it('consume returns the bound identity exactly once (single-use)', () => {
    const store = new EnrollmentTicketStore();
    const id = store.issue(alice);
    expect(store.consume(id)).toEqual(alice);
    expect(store.consume(id)).toBeNull();
    expect(store.peek(id)).toBeNull();
  });

  it('returns null for unknown ticket ids', () => {
    const store = new EnrollmentTicketStore();
    expect(store.peek('nope')).toBeNull();
    expect(store.consume('nope')).toBeNull();
  });

  it('expires tickets after the configured TTL', () => {
    let now = 1_000_000;
    const store = new EnrollmentTicketStore(600_000, () => now);
    const id = store.issue(alice);
    now += 599_999;
    expect(store.peek(id)).toEqual(alice);
    now += 2;
    expect(store.peek(id)).toBeNull();
    expect(store.consume(id)).toBeNull();
  });

  it('re-issuing for the same identity invalidates the previous ticket', () => {
    const store = new EnrollmentTicketStore();
    const first = store.issue(alice);
    const second = store.issue(alice);
    expect(store.consume(first)).toBeNull();
    expect(store.consume(second)).toEqual(alice);
  });

  it('keeps tickets for different identities independent', () => {
    const store = new EnrollmentTicketStore();
    const a = store.issue(alice);
    const b = store.issue(bob);
    expect(store.consume(a)).toEqual(alice);
    expect(store.consume(b)).toEqual(bob);
  });

  it('sweeps expired tickets and enforces a global pending cap', () => {
    let now = 0;
    const store = new EnrollmentTicketStore(1_000, () => now);
    for (let i = 0; i < MAX_PENDING_TICKETS; i++) {
      store.issue({ issuer: 'https://idp.example.test', sub: `user-${i}` });
    }
    // Cap reached with nothing expired -> refuse loudly.
    expect(() => store.issue(alice)).toThrow(/enrollment/i);
    // Once the old tickets expire, issuing works again (sweep frees space).
    now += 1_001;
    expect(() => store.issue(alice)).not.toThrow();
  });
});
