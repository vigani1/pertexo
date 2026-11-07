import { randomUUID } from 'node:crypto';
import { createApplicationSecretEnvelope } from '@pertexo/secrets/server';
import { expect } from 'vitest';

import {
  invitationKeys,
  setCookie,
  useBetterAuthRealApi,
  type Browser,
} from '../../support/better-auth/real-api.support.js';

export function invitationApi(suite: string) {
  const api = useBetterAuthRealApi(suite);
  async function person() {
    const email = `${randomUUID()}@example.test`;
    await api.signUp(email, '/login?verified=true');
    const browser = await api.signIn(email);
    const id = (await api.send('GET', '/v1/users/me', { browser })).json<{
      id: string;
    }>().id;
    return { email, browser, id };
  }
  async function team() {
    const owner = await person();
    const created = await api.send('POST', '/v1/workspaces', {
      browser: owner.browser,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        name: 'Invitation boundaries',
        slug: `boundary-${randomUUID()}`,
      },
    });
    expect(created.statusCode, created.payload).toBe(201);
    return { owner, workspaceId: created.json<{ id: string }>().id };
  }
  async function invite(workspaceId: string, owner: Browser, email: string) {
    const created = await api.send(
      'POST',
      `/v1/workspaces/${workspaceId}/invitations`,
      {
        browser: owner,
        headers: { 'idempotency-key': randomUUID() },
        payload: { email, role: 'viewer' },
      },
    );
    expect(created.statusCode, created.payload).toBe(202);
    const id = created.json<{ invitation: { id: string } }>().invitation.id;
    const row = (
      await api.database().query<{
        id: string;
        token_ciphertext: string;
        token_nonce: string;
        token_tag: string;
        token_key_version: string;
      }>('select id,token_ciphertext,token_nonce,token_tag,token_key_version from app.workspace_invitation_delivery_attempts where invitation_id=$1', [id])
    ).rows[0];
    if (row === undefined) throw new Error('Invitation delivery missing');
    const token = createApplicationSecretEnvelope(invitationKeys).open(
      {
        ciphertext: row.token_ciphertext,
        nonce: row.token_nonce,
        tag: row.token_tag,
        keyVersion: row.token_key_version,
      },
      `pertexo/workspace-invitation/${workspaceId}/${id}/${row.id}`,
    );
    return { id, token };
  }
  const resolve = (token: string) =>
    api.send('POST', '/v1/invitation-acceptance/resolve', {
      headers: { 'x-pertexo-invitation-request': 'resolve' },
      payload: { token },
    });
  async function ready() {
    const world = await team();
    const recipient = await person();
    const invitation = await invite(
      world.workspaceId,
      world.owner.browser,
      recipient.email,
    );
    const resolved = await resolve(invitation.token);
    expect(resolved.statusCode, resolved.payload).toBe(201);
    const binding = setCookie(resolved, 'pertexo_invitation_intent');
    const bound = {
      ...recipient.browser,
      cookie: `${recipient.browser.cookie}; pertexo_invitation_intent=${binding}`,
    };
    const csrf = resolved.json<{ csrfToken: string }>().csrfToken;
    const proved = await api.send('POST', '/v1/invitation-acceptance/session', {
      browser: bound,
      headers: { 'x-invitation-csrf-token': csrf },
      payload: {},
    });
    expect(proved.statusCode, proved.payload).toBe(200);
    const journey = proved.json<{
      intentId: string;
      invitationRevision: number;
    }>();
    const key = randomUUID();
    const complete = (browser = bound) =>
      api.send('POST', '/v1/invitation-acceptance/complete', {
        browser,
        headers: { 'x-invitation-csrf-token': csrf, 'idempotency-key': key },
        payload: {
          intentId: journey.intentId,
          expectedRevision: journey.invitationRevision,
        },
      });
    return { ...world, recipient, invitation, bound, journey, csrf, complete };
  }
  return { ...api, person, team, invite, resolve, ready };
}
