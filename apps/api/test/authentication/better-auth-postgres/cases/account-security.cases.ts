import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { expect, it } from 'vitest';

import {
  adminUrl,
  databaseUrl,
  apiUrl,
  mailedMessages,
  runtime,
  authRequest,
  cookieValue,
  cookieName,
  authenticatedRequest,
  followMailLink,
} from '../fixture.js';

export function registerUsesStableUserRowVerifiesEmail(): void {
  it('uses the stable user row, verifies email, issues one durable authority, and rejects suspended users', async () => {
    const session = await createVerifiedSession();
    const controls = await verifySessionControls(session);
    const password = await verifyPasswordReplacement({
      ...session,
      ...controls,
    });
    const method = await verifyMethodUnlinkAudit({
      ...session,
      ...controls,
      ...password,
    });
    const email = await verifyEmailReplacement({ ...controls, ...method });
    await verifySuspendedSession({ ...session, ...password, ...email });
  });
}

type VerifiedSession = Awaited<ReturnType<typeof createVerifiedSession>>;
type SessionControls = Awaited<ReturnType<typeof verifySessionControls>>;
type PasswordReplacement = Awaited<
  ReturnType<typeof verifyPasswordReplacement>
>;
type MethodUnlink = Awaited<ReturnType<typeof verifyMethodUnlinkAudit>>;
type EmailReplacement = Awaited<ReturnType<typeof verifyEmailReplacement>>;

async function createVerifiedSession() {
  const signUp = await authRequest('/v1/auth/sign-up/email', {
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    password: 'correct horse battery staple',
    callbackURL: '/login',
  });
  expect(signUp.status).toBe(200);
  expect(signUp.headers.getSetCookie()).toHaveLength(0);

  const verification = mailedMessages('ada@example.test').find(
    (message) => message.purpose === 'verification',
  );
  expect(verification).toBeDefined();
  const verificationUrl = new URL(verification?.url ?? 'http://invalid');
  const verify = await runtime.auth.handler(
    new Request(verificationUrl, {
      headers: { origin: 'http://pertexo.test' },
      redirect: 'manual',
    }),
  );
  expect([200, 302]).toContain(verify.status);

  const signIn = await authRequest('/v1/auth/sign-in/email', {
    email: 'ada@example.test',
    password: 'correct horse battery staple',
    callbackURL: '/workspaces',
  });
  expect(signIn.status).toBe(200);
  const signInCookies = signIn.headers.getSetCookie();
  expect(signInCookies.map(cookieName)).toContain('pertexo_session');
  const signedCookie = cookieValue(signInCookies);
  expect(signedCookie).toBeDefined();
  const authenticated = await runtime.sessions.authenticate(signedCookie ?? '');
  expect(authenticated?.userId).toMatch(/^[0-9a-f-]{36}$/u);

  return { signedCookie, authenticated };
}

async function verifySessionControls(evidence: VerifiedSession) {
  const { signedCookie, authenticated } = evidence;
  const secondSession = await runtime.sessions.issue(
    authenticated?.userId ?? '',
  );
  const secondCookie = cookieValue(secondSession.setCookies);
  expect(secondCookie).toBeDefined();
  const csrf = 'test-csrf-token-with-more-than-thirty-two-characters';
  const list = await authenticatedRequest({
    path: '/v1/auth/account-security/sessions',
    method: 'GET',
    sessionCookie: signedCookie ?? '',
    csrf: csrf,
  });
  expect(list.status).toBe(200);
  const listed = (await list.json()) as {
    items: { id: string; current: boolean; token?: string }[];
  };
  expect(listed.items).toHaveLength(2);
  expect(listed.items.every((session) => session.token === undefined)).toBe(
    true,
  );
  expect(listed.items.some((session) => session.current)).toBe(true);

  const missingCsrf = await authenticatedRequest({
    path: '/v1/auth/account-security/sessions/revoke',
    method: 'POST',
    sessionCookie: signedCookie ?? '',
    csrf: undefined,
    body: { sessionId: secondSession.sessionId },
  });
  expect(missingCsrf.status).toBe(403);
  expect(await runtime.sessions.authenticate(secondCookie ?? '')).toBeDefined();

  const revoke = await authenticatedRequest({
    path: '/v1/auth/account-security/sessions/revoke',
    method: 'POST',
    sessionCookie: signedCookie ?? '',
    csrf: csrf,
    body: { sessionId: secondSession.sessionId },
  });
  expect(revoke.status).toBe(200);
  expect(await revoke.json()).toEqual({ revoked: true });
  expect(
    await runtime.sessions.authenticate(secondCookie ?? ''),
  ).toBeUndefined();

  const methods = await authenticatedRequest({
    path: '/v1/auth/account-security',
    method: 'GET',
    sessionCookie: signedCookie ?? '',
    csrf: csrf,
  });
  expect(methods.status).toBe(200);
  const methodsBody = (await methods.json()) as {
    methods: { id: string; kind: string; provider: string | null }[];
  };
  expect(methodsBody).toMatchObject({
    email: 'ada@example.test',
    emailVerified: true,
    methods: [{ kind: 'password', provider: null }],
  });
  const passwordMethodId = methodsBody.methods[0]?.id;

  const blockedLink = await authenticatedRequest({
    path: '/v1/auth/link-social',
    method: 'POST',
    sessionCookie: signedCookie ?? '',
    csrf: csrf,
    body: {
      provider: 'google',
      callbackURL: '/account/security',
      disableRedirect: true,
    },
  });
  expect(blockedLink.status).toBe(403);
  const afterBlockedLink = await authenticatedRequest({
    path: '/v1/auth/account-security',
    method: 'GET',
    sessionCookie: signedCookie ?? '',
    csrf: csrf,
  });
  expect(
    ((await afterBlockedLink.json()) as { methods: unknown[] }).methods,
  ).toHaveLength(1);

  return { csrf, passwordMethodId };
}

async function verifyPasswordReplacement(
  evidence: VerifiedSession & SessionControls,
) {
  const { signedCookie, csrf, passwordMethodId } = evidence;
  const passwordChange = await authenticatedRequest({
    path: '/v1/auth/account-security/password/change',
    method: 'POST',
    sessionCookie: signedCookie ?? '',
    csrf: csrf,
    body: {
      currentPassword: 'correct horse battery staple',
      newPassword: 'another correct horse battery staple',
    },
  });
  expect(passwordChange.status).toBe(200);
  const replacementCookie = cookieValue(passwordChange.headers.getSetCookie());
  expect(replacementCookie).toBeDefined();
  expect(replacementCookie).not.toBe(signedCookie);
  expect(
    await runtime.sessions.authenticate(signedCookie ?? ''),
  ).toBeUndefined();
  expect(
    await runtime.sessions.authenticate(replacementCookie ?? ''),
  ).toBeDefined();

  const oldPassword = await authRequest('/v1/auth/sign-in/email', {
    email: 'ada@example.test',
    password: 'correct horse battery staple',
    callbackURL: '/workspaces',
  });
  expect(oldPassword.status).toBe(401);
  const newPassword = await authRequest('/v1/auth/sign-in/email', {
    email: 'ada@example.test',
    password: 'another correct horse battery staple',
    callbackURL: '/workspaces',
  });
  expect(newPassword.status).toBe(200);

  const lastMethod = await authenticatedRequest({
    path: '/v1/auth/account-security/methods/unlink',
    method: 'POST',
    sessionCookie: replacementCookie ?? '',
    csrf: csrf,
    body: { methodId: passwordMethodId },
  });
  expect(lastMethod.status).toBe(400);

  return { replacementCookie };
}

async function verifyMethodUnlinkAudit(
  evidence: VerifiedSession & PasswordReplacement & SessionControls,
) {
  const { authenticated, replacementCookie, csrf } = evidence;
  const socialMethodId = randomUUID();
  const setup = new Pool({ connectionString: apiUrl, max: 1 });
  try {
    await setup.query(
      `insert into app.auth_accounts
          (id,account_id,provider_id,user_id,created_at,updated_at)
         values($1,'google-subject','google',$2,clock_timestamp(),clock_timestamp())`,
      [socialMethodId, authenticated?.userId],
    );
  } finally {
    await setup.end();
  }
  const unlink = await authenticatedRequest({
    path: '/v1/auth/account-security/methods/unlink',
    method: 'POST',
    sessionCookie: replacementCookie ?? '',
    csrf: csrf,
    body: { methodId: socialMethodId },
  });
  expect(unlink.status).toBe(200);
  expect(await unlink.json()).toEqual({ unlinked: true });
  const auditReader = new Pool({
    connectionString: databaseUrl(adminUrl),
    max: 1,
  });
  try {
    const facts = await auditReader.query<{
      event_type: string;
      count: number;
    }>(
      `select event_type,count(*)::integer count
           from app.identity_security_audit_facts
          where user_id=$1 and event_type in ('method.unlinked','password.changed')
          group by event_type order by event_type`,
      [authenticated?.userId],
    );
    expect(facts.rows).toEqual([
      { event_type: 'method.unlinked', count: 1 },
      { event_type: 'password.changed', count: 1 },
    ]);
  } finally {
    await auditReader.end();
  }
  const unlinkCookie = cookieValue(unlink.headers.getSetCookie());
  expect(unlinkCookie).toBeDefined();
  expect(
    await runtime.sessions.authenticate(replacementCookie ?? ''),
  ).toBeUndefined();
  expect(await runtime.sessions.authenticate(unlinkCookie ?? '')).toBeDefined();

  return { unlinkCookie };
}

async function verifyEmailReplacement(
  evidence: MethodUnlink & SessionControls,
) {
  const { unlinkCookie, csrf } = evidence;
  const changeEmail = await authenticatedRequest({
    path: '/v1/auth/change-email',
    method: 'POST',
    sessionCookie: unlinkCookie ?? '',
    csrf: csrf,
    body: {
      newEmail: 'ada.new@example.test',
      callbackURL: '/login?emailChanged=true',
    },
  });
  expect(changeEmail.status).toBe(200);
  const oldAddressConfirmation = mailedMessages('ada@example.test').find(
    (message) => message.purpose === 'email_change_confirmation',
  );
  expect(oldAddressConfirmation).toBeDefined();
  const confirmOld = await followMailLink(
    oldAddressConfirmation?.url ?? 'http://invalid',
    unlinkCookie ?? '',
  );
  expect([200, 302]).toContain(confirmOld.status);
  expect(confirmOld.headers.get('location')).toContain(
    'emailChangePending=true',
  );
  const newAddressVerification = mailedMessages('ada.new@example.test').find(
    (message) => message.purpose === 'verification',
  );
  expect(newAddressVerification).toBeDefined();
  const replayOld = await followMailLink(
    oldAddressConfirmation?.url ?? 'http://invalid',
    unlinkCookie ?? '',
  );
  expect(replayOld.headers.get('location')).toContain(
    'error=verification_invalid',
  );
  expect(
    mailedMessages('ada.new@example.test').filter(
      (message) => message.purpose === 'verification',
    ),
  ).toHaveLength(1);
  const verifyNew = await followMailLink(
    newAddressVerification?.url ?? 'http://invalid',
    unlinkCookie ?? '',
  );
  expect([200, 302]).toContain(verifyNew.status);
  expect(verifyNew.headers.get('location')).toContain('emailChanged=true');
  const replayNew = await followMailLink(
    newAddressVerification?.url ?? 'http://invalid',
    unlinkCookie ?? '',
  );
  expect(replayNew.headers.get('location')).toContain(
    'error=verification_invalid',
  );
  expect(
    await runtime.sessions.authenticate(unlinkCookie ?? ''),
  ).toBeUndefined();
  const newEmailSignIn = await authRequest('/v1/auth/sign-in/email', {
    email: 'ada.new@example.test',
    password: 'another correct horse battery staple',
    callbackURL: '/workspaces',
  });
  expect(newEmailSignIn.status).toBe(200);
  const newEmailCookie = cookieValue(newEmailSignIn.headers.getSetCookie());
  expect(newEmailCookie).toBeDefined();

  return { newEmailCookie };
}

async function verifySuspendedSession(
  evidence: VerifiedSession & PasswordReplacement & EmailReplacement,
) {
  const { signedCookie, replacementCookie, newEmailCookie } = evidence;
  const api = new Pool({ connectionString: apiUrl, max: 1 });
  try {
    const rows = await api.query<{
      id: string;
      token: string;
      email_verified: boolean;
    }>(
      `select sessions.id,sessions.token,users.email_verified
           from app.auth_sessions sessions
           join app.users users on users.id=sessions.user_id
          where users.email='ada.new@example.test'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows.every((row) => row.email_verified)).toBe(true);
    expect(rows.rows.every((row) => row.token !== signedCookie)).toBe(true);
    expect(rows.rows.every((row) => row.token !== replacementCookie)).toBe(
      true,
    );
    await api.query(
      `update app.users set status='suspended',updated_at=clock_timestamp()
          where email='ada.new@example.test'`,
    );
    const revoked = await api.query<{ count: number }>(
      `select count(*)::integer count
           from app.auth_sessions sessions
           join app.users users on users.id=sessions.user_id
          where users.email='ada.new@example.test'`,
    );
    expect(revoked.rows).toEqual([{ count: 0 }]);
  } finally {
    await api.end();
  }
  expect(
    await runtime.sessions.authenticate(newEmailCookie ?? ''),
  ).toBeUndefined();
}
