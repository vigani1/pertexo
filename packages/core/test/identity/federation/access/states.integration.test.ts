import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { isAuthenticationSessionAllowed } from '../../../../src/identity/index.js';
import {
  READS,
  commands,
  db,
  organization,
  outcome,
  ownerActions,
  pool,
  setStatus,
  signIn,
} from './fixture.js';

describe('what each workspace state allows', () => {
  it('a suspended workspace still shows its settings, and changes nothing', async () => {
    const f = await organization();
    await setStatus(f.control, 'suspended');
    for (const [name, read] of READS)
      expect(await outcome(read(f.scope)), name).toBe('answered');
    for (const [name, act] of [...ownerActions(f), ...commands(f)])
      expect(await outcome(act(f.scope)), name).not.toBe('answered');
  }, 60_000);

  it('a workspace pending deletion closes all of it to its members', async () => {
    const f = await organization();
    await setStatus(f.control, 'pending_deletion');
    for (const [name, read] of READS)
      expect(await outcome(read(f.scope)), name).toBe('access denied');
    for (const [name, act] of [...ownerActions(f), ...commands(f)])
      expect(await outcome(act(f.scope)), name).not.toBe('answered');
  }, 60_000);

  it.each([
    ['pending_deletion', true],
    ['purging', false],
  ] as const)(
    'sign-in against a %s control workspace answers: %s',
    async (status, open) => {
      const f = await organization();
      const person = await db.user('Signed in');
      await db.asAdmin(
        'update app.auth_domains set require_sso=false where id=$1',
        [f.domainId],
      );
      await db.asAdmin(
        'update app.users set email=$2,email_verified=true where id=$1',
        [person.id, `person@${f.domain}`],
      );
      const state = randomBytes(32),
        browser = randomBytes(32);
      const found = await signIn.provider(f.providerId, f.domain);
      const providerRevision = found?.provider.revision;
      if (providerRevision === undefined) throw new Error('Provider missing');
      await signIn.start({
        id: randomUUID(),
        providerId: f.providerId,
        providerRevision,
        domainId: f.domainId,
        purpose: 'sign_in',
        stateDigest: state,
        browserDigest: browser,
        returnPath: '/workspaces',
      });

      await setStatus(f.control, status);

      // After the change: a lifecycle change ends the sessions it finds.
      const sessionId = randomUUID();
      await db.asAdmin(
        `insert into app.auth_sessions(id,expires_at,token,user_id,authentication_method,federation_provider_id,federation_provider_revision)
         values($1,clock_timestamp()+interval '1 hour',$2,$3,'organization',$4,$5)`,
        [sessionId, randomUUID(), person.id, f.providerId, providerRevision],
      );
      const discovered = await signIn.discover(f.domain);
      const stillFound = await signIn.provider(f.providerId, f.domain);
      const attempt = await signIn.find(state, browser);
      const session = await isAuthenticationSessionAllowed(pool, sessionId);
      const started = await outcome(
        signIn.start({
          id: randomUUID(),
          providerId: f.providerId,
          providerRevision,
          domainId: f.domainId,
          purpose: 'sign_in',
          stateDigest: randomBytes(32),
          browserDigest: randomBytes(32),
          returnPath: '/workspaces',
        }),
      );
      expect({
        discovered: discovered.providers.length > 0,
        found: Boolean(stillFound),
        attempt: Boolean(attempt),
        session,
        started: started === 'answered',
      }).toEqual({
        discovered: open,
        found: open,
        attempt: open,
        session: open,
        started: open,
      });
    },
    60_000,
  );
});
