import { createHash, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import {
  workspaceMembersResponseSchema,
  directoryCredentialResultSchema,
  directorySettingsSchema,
} from '@pertexo/contracts';
import { browserFrom } from '../../../../support/better-auth/real-api.support.js';
import { encryption } from '../../organization/fixture.js';

import type { createDirectoryFixture } from './fixture.js';
import { patch } from './fixture.js';

export function registerBindsThroughVerifiedSSOUnprovisionedJITOff(
  caseFixture: ReturnType<typeof createDirectoryFixture>,
): void {
  const { setup, api, createPerson } = caseFixture;

  it('binds only through verified SSO with unprovisioned JIT off, and deactivation immediately fences sessions and JIT', async () => {
    const f = await setup(),
      email = `managed@${f.domain}`;
    const settingsReply = await api.send(
      'GET',
      `/v1/workspaces/${f.workspaceId}/sso`,
      { browser: f.owner },
    );
    const organization = settingsReply.json<{
      organization: { revision: number };
    }>().organization;
    await api.command({
      workspaceId: f.workspaceId,
      browser: f.owner,
      path: `/providers/${f.providerId}`,
      payload: {
        name: 'Fixture OIDC',
        configuration: { clientId: 'fixture-client', jitEnabled: false },
        enabled: true,
        expectedRevision: organization.revision,
      },
      method: 'PUT',
    });
    const created = await createPerson(f, email);
    expect(created.statusCode, created.payload).toBe(201);
    const userId = created.json<{ id: string }>().id;
    expect(
      (
        await api
          .database()
          .query('select id from app.users where email=$1', [email])
      ).rowCount,
    ).toBe(0);
    const identity = api.person(email),
      signedIn = await api.finish(await api.start(f, identity));
    expect(signedIn.headers.location).not.toContain('ssoError');
    const browser = browserFrom(signedIn);
    const members = await api.send(
      'GET',
      `/v1/workspaces/${f.workspaceId}/members`,
      { browser: f.owner },
    );
    expect(members.statusCode, members.payload).toBe(200);
    const member = workspaceMembersResponseSchema
      .parse(members.json())
      .items.find((entry) => entry.email === email);
    expect(member?.directorySource?.directoryUserId).toBe(userId);
    if (member === undefined) throw new Error('Managed membership missing');
    const manualRoleChange = await api.send(
      'POST',
      `/v1/workspaces/${f.workspaceId}/members/${member.userId}/role`,
      {
        browser: f.owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: { role: 'admin', expectedRoleRevision: member.roleRevision },
      },
    );
    expect(manualRoleChange.statusCode, manualRoleChange.payload).toBe(409);
    expect(manualRoleChange.payload).toContain('organization directory');
    const deactivated = await api.send('PATCH', `${f.base}/Users/${userId}`, {
      headers: f.headers,
      payload: patch([{ op: 'replace', path: 'active', value: false }]),
    });
    expect(deactivated.statusCode, deactivated.payload).toBe(200);
    expect(
      (await api.send('GET', '/v1/users/me', { browser })).statusCode,
    ).toBe(401);
    expect(
      (await api.finish(await api.start(f, identity))).headers.location,
    ).toContain('ssoError');
    const sessionCount = await api
      .database()
      .query<{ count: number }>(
        'select count(*)::integer count from app.auth_sessions session join app.users person on person.id=session.user_id where person.email=$1',
        [email],
      );
    expect(sessionCount.rows[0]?.count).toBe(0);
    expect(
      (
        await api.send('DELETE', `${f.base}/Users/${userId}`, {
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(204);
    const replacement = await createPerson(f, email);
    expect(replacement.statusCode, replacement.payload).toBe(201);
    const restored = await api.finish(await api.start(f, identity));
    expect(restored.headers.location).not.toContain('ssoError');
    const refreshedMembers = await api.send(
      'GET',
      `/v1/workspaces/${f.workspaceId}/members`,
      { browser: f.owner },
    );
    expect(
      workspaceMembersResponseSchema
        .parse(refreshedMembers.json())
        .items.find((entry) => entry.email === email)?.directorySource
        ?.directoryUserId,
    ).toBe(replacement.json<{ id: string }>().id);
  });

  it('replays credential creation without a secret, never stores plaintext, and revokes machine access immediately', async () => {
    const f = await setup();
    const peer = await api.createIdentityPeer(encryption),
      digest = createHash('sha256').update(f.credential.secret).digest('hex');
    const organizationId = f.settings.organization?.id;
    if (organizationId === undefined) throw new Error('Missing organization');
    await expect(
      peer.directory.authenticate(organizationId, digest),
    ).resolves.toHaveProperty('credentialId', f.credential.credential.id);
    const before = await api.send(
      'GET',
      `/v1/workspaces/${f.workspaceId}/sso/directory`,
      { browser: f.owner },
    );
    const settings = directorySettingsSchema.parse(before.json()),
      key = randomUUID();
    const input = {
      browser: f.owner,
      headers: { 'idempotency-key': key },
      payload: {
        name: 'Retry credential',
        expectedRevision: settings.revision,
      },
    };
    const first = await api.send(
        'POST',
        `/v1/workspaces/${f.workspaceId}/sso/directory/credentials`,
        input,
      ),
      replay = await api.send(
        'POST',
        `/v1/workspaces/${f.workspaceId}/sso/directory/credentials`,
        input,
      );
    expect(first.statusCode, first.payload).toBe(200);
    expect(replay.statusCode, replay.payload).toBe(200);
    const issued = directoryCredentialResultSchema.parse(first.json());
    if (issued.replayed) throw new Error('Fresh credential replayed');
    expect(replay.json()).toMatchObject({
      replayed: true,
      credential: { id: issued.credential.id },
    });
    expect(replay.payload).not.toContain(issued.secret);
    const stored = await api
      .database()
      .query(
        'select secret_digest from app.auth_provisioning_credentials where id=$1',
        [issued.credential.id],
      );
    const receipts = await api
      .database()
      .query(
        'select result_ref from app.idempotency_records where workspace_id=$1',
        [f.workspaceId],
      );
    expect(JSON.stringify([stored.rows, receipts.rows])).not.toContain(
      issued.secret,
    );
    const revoked = await api.send(
      'POST',
      `/v1/workspaces/${f.workspaceId}/sso/directory/credentials/${f.credential.credential.id}/revoke`,
      {
        browser: f.owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: { expectedRevision: settings.revision + 1 },
      },
    );
    expect(revoked.statusCode, revoked.payload).toBe(200);
    expect(
      (
        await api.send('GET', `${f.base}/ServiceProviderConfig`, {
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(401);
    await expect(
      peer.directory.authenticate(organizationId, digest),
    ).rejects.toHaveProperty('reason', 'unauthorized');
  });
}
