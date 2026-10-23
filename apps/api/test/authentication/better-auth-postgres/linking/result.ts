import { Pool } from 'pg';
import { expect } from 'vitest';

import { adminUrl, databaseUrl } from '../environment.js';
import { runtime } from '../lifecycle.js';
import { required, cookieValue } from '../requests.js';
import type {
  ProviderLinkScenario,
  ProviderLinkStart,
  ProviderLinkCallbacks,
  CallbackOrdering,
} from './contract.js';

function providerLinkOutcome({
  response,
  acceptedLanding,
  linkErrorLanding,
  reauthenticateLanding,
}: Readonly<{
  response: Response;
  acceptedLanding: string;
  linkErrorLanding: string;
  reauthenticateLanding: string;
}>) {
  if (response.headers.get('location') === acceptedLanding) return 'linked';
  if (response.headers.get('location') === linkErrorLanding)
    return 'link-error';
  if (response.headers.get('location') === reauthenticateLanding)
    return 'reauthenticate';
  return 'other';
}

export async function assertProviderLinkResult({
  scenario,
  started,
  callbacks,
  ordering,
}: Readonly<{
  scenario: ProviderLinkScenario;
  started: ProviderLinkStart;
  callbacks: ProviderLinkCallbacks;
  ordering: CallbackOrdering;
}>) {
  const { email, originalCookie, linkRequest, proofState } = scenario;
  const { binding, callback } = started;
  const { first, second, authenticationCalls } = callbacks;
  if (ordering === 'loser authentication after commit')
    expect(authenticationCalls).toBe(2);
  if (ordering === 'both provider proofs before commit')
    expect(proofState.count).toBe(2);
  const responses = [first, second];
  const acceptedLanding = 'http://pertexo.test/account/security?linked=true';
  const linkErrorLanding =
    'http://pertexo.test/account/security?linkError=true';
  const reauthenticateLanding =
    'http://pertexo.test/login?error=link_reauthenticate';
  const linked = responses.filter(
    (response) =>
      response.status === 302 &&
      response.headers.get('location') === acceptedLanding,
  );
  const rejected = responses.filter(
    (response) =>
      response.status === 302 &&
      [linkErrorLanding, reauthenticateLanding].includes(
        response.headers.get('location') ?? '',
      ) &&
      response.headers.getSetCookie().length === 0,
  );
  const validCallbackPair =
    linked.length === 1 &&
    rejected.length === 1 &&
    cookieValue(required(linked[0]).headers.getSetCookie()) !== undefined;
  let mismatchEvidence: unknown;
  if (!validCallbackPair) {
    const admin = new Pool({
      connectionString: databaseUrl(adminUrl),
      max: 1,
    });
    try {
      const state = await admin.query<{
        phase: string;
        accounts: number;
        audits: number;
        sessions: number;
      }>(
        `select attempt.phase,
                    (select count(*)::integer from app.auth_accounts account
                      where account.user_id=users.id and account.provider_id='google') accounts,
                    (select count(*)::integer from app.identity_security_audit_facts audit
                      where audit.user_id=users.id and audit.event_type='method.linked') audits,
                    (select count(*)::integer from app.auth_sessions session
                      where session.user_id=users.id) sessions
               from app.users users
               join app.auth_method_link_attempts attempt on attempt.user_id=users.id
              where users.email=$1`,
        [email],
      );
      mismatchEvidence = {
        outcomes: responses.map((response) => ({
          status: response.status,
          kind: providerLinkOutcome({
            response,
            acceptedLanding,
            linkErrorLanding,
            reauthenticateLanding,
          }),
          sessionCookieIssued:
            cookieValue(response.headers.getSetCookie()) !== undefined,
        })),
        durable: state.rows,
      };
    } finally {
      await admin.end();
    }
  }
  if (!validCallbackPair)
    throw new Error(
      `Expected one accepted and one safely rejected account-link callback: ${JSON.stringify(mismatchEvidence)}`,
    );
  expect(linked).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  if (ordering === 'loser authentication after commit') {
    expect(first.headers.get('location')).toBe(acceptedLanding);
    expect(second.headers.get('location')).toBe(reauthenticateLanding);
  }
  if (ordering === 'both provider proofs before commit')
    expect(required(rejected[0]).headers.get('location')).toBe(
      linkErrorLanding,
    );
  const accepted = required(linked[0]);
  const replacementCookie = cookieValue(accepted.headers.getSetCookie());
  expect(replacementCookie).toBeDefined();
  expect(
    await runtime.sessions.authenticate(originalCookie ?? ''),
  ).toBeUndefined();
  expect(
    await runtime.sessions.authenticate(replacementCookie ?? ''),
  ).toBeDefined();
  const replay = await linkRequest({
    path: callback,
    method: 'GET',
    session: replacementCookie ?? '',
    binding: binding,
  });
  expect(replay.status).toBe(302);
  expect(replay.headers.get('location')).toBe(linkErrorLanding);
  expect(replay.headers.getSetCookie()).toEqual([]);

  const admin = new Pool({
    connectionString: databaseUrl(adminUrl),
    max: 1,
  });
  try {
    const state = await admin.query<{
      accounts: number;
      audits: number;
      sessions: number;
    }>(
      `select
             (select count(*)::integer from app.auth_accounts account
               join app.users users on users.id=account.user_id
               where users.email=$1 and account.provider_id='google') accounts,
             (select count(*)::integer from app.identity_security_audit_facts audit
               join app.users users on users.id=audit.user_id
               where users.email=$1 and audit.event_type='method.linked') audits,
             (select count(*)::integer from app.auth_sessions session
               join app.users users on users.id=session.user_id
               where users.email=$1) sessions`,
      [email],
    );
    expect(state.rows).toEqual([{ accounts: 1, audits: 1, sessions: 1 }]);
  } finally {
    await admin.end();
  }

  return replacementCookie;
}
