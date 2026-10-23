import { randomUUID } from 'node:crypto';

import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';

import { expect, it } from 'vitest';

import {
  SESSION_AUTHORITY,
  type IdentitySessionAuthority,
} from '../../../../src/workspaces/index.js';

import { invitationKeys } from '../environment.js';
import { sessionCookies, cookieValue, mutationHeaders } from '../cookies.js';
import { withTimeout, openHttpEventStream } from '../streams.js';
import { expectProblem } from '../assertions.js';

import type { createWorkspaceApiFixture } from '../fixture.js';

export function registerAcceptsDeliveredInvitationOnceRotatesRecipientSession(
  caseFixture: ReturnType<typeof createWorkspaceApiFixture>,
): void {
  const {
    signUp,
    signIn,
    createWorkspace,
    createPublishedWorkflow,
    withOwnerWorkspace,
    workspaceAggregate,
  } = caseFixture;

  it('accepts a delivered invitation once, rotates the recipient session, and closes an existing SSE stream', async () => {
    const managerEmail = `${randomUUID()}@example.test`;
    await signUp(managerEmail, 'Invitation integration manager');
    const managerCookies = await signIn(managerEmail);
    const invitedWorkspaceId = await createWorkspace(
      managerCookies,
      'Invitation acceptance proof',
    );
    const streamWorkspaceId = await createWorkspace(
      managerCookies,
      'Invitation stream proof',
    );
    const { base, createdBody } = await createPublishedWorkflow(
      managerCookies,
      streamWorkspaceId,
    );
    const started = await caseFixture.application.inject({
      method: 'POST',
      url: `${base}/${createdBody.workflow.id}/runs`,
      headers: mutationHeaders(managerCookies, {
        'idempotency-key': `invitation-run-${randomUUID()}`,
      }),
      payload: { input: { source: 'invitation-session-proof' } },
    });
    expect(started.statusCode, started.payload).toBe(202);
    const runId = started.json<{ run: { id: string } }>().run.id;
    const runUrl = `/v1/workspaces/${streamWorkspaceId}/runs/${runId}`;
    const recipientEmail = `${randomUUID()}@example.test`;
    const createdInvitation = await caseFixture.application.inject({
      method: 'POST',
      url: `/v1/workspaces/${invitedWorkspaceId}/invitations`,
      headers: mutationHeaders(managerCookies, {
        'idempotency-key': `invitation-create-${randomUUID()}`,
      }),
      payload: { email: recipientEmail, role: 'viewer' },
    });
    expect(createdInvitation.statusCode, createdInvitation.payload).toBe(202);
    const invitationId = createdInvitation.json<{
      invitation: { id: string };
    }>().invitation.id;
    let invitationToken = '';
    await withOwnerWorkspace(invitedWorkspaceId, async (client) => {
      const delivery = await client.query<{
        id: string;
        token_ciphertext: string;
        token_nonce: string;
        token_tag: string;
        token_key_version: string;
      }>(
        `select id,token_ciphertext,token_nonce,token_tag,token_key_version
           from app.workspace_invitation_delivery_attempts
          where workspace_id=$1 and invitation_id=$2`,
        [invitedWorkspaceId, invitationId],
      );
      const row = delivery.rows[0];
      if (row === undefined)
        throw new Error('Invitation delivery was not stored');
      invitationToken = createApplicationSecretEnvelope(invitationKeys).open(
        {
          ciphertext: row.token_ciphertext,
          nonce: row.token_nonce,
          tag: row.token_tag,
          keyVersion: row.token_key_version,
        },
        `pertexo/workspace-invitation/${invitedWorkspaceId}/${invitationId}/${row.id}`,
      );
    });

    const resolved = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/invitation-acceptance/resolve',
      remoteAddress: '198.51.100.25',
      headers: {
        origin: 'https://api.integration.test',
        'content-type': 'application/json',
        'x-pertexo-invitation-request': 'resolve',
      },
      payload: { token: invitationToken },
    });
    expect(resolved.statusCode, resolved.payload).toBe(201);
    let resolvedBody = resolved.json<{
      state: string;
      intentId: string;
      csrfToken: string;
    }>();
    expect(resolvedBody.state).toBe('sign_in_required');
    const originalInvitationBinding = cookieValue(
      Array.isArray(resolved.headers['set-cookie'])
        ? resolved.headers['set-cookie']
        : [String(resolved.headers['set-cookie'])],
      'pertexo_invitation_intent',
    );
    const lostReplacement = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/invitation-acceptance/resolve',
      remoteAddress: '198.51.100.25',
      headers: {
        cookie: `pertexo_invitation_intent=${encodeURIComponent(originalInvitationBinding)}`,
        origin: 'https://api.integration.test',
        'content-type': 'application/json',
        'x-pertexo-invitation-request': 'resolve',
      },
      payload: { token: invitationToken },
    });
    expect(lostReplacement.statusCode, lostReplacement.payload).toBe(201);
    const lostReplacementBody = lostReplacement.json<{
      state: string;
      intentId: string;
      csrfToken: string;
    }>();
    const lostReplacementBinding = cookieValue(
      Array.isArray(lostReplacement.headers['set-cookie'])
        ? lostReplacement.headers['set-cookie']
        : [String(lostReplacement.headers['set-cookie'])],
      'pertexo_invitation_intent',
    );
    const recoveredReplacement = await caseFixture.application.inject({
      method: 'POST',
      url: '/v1/invitation-acceptance/resolve',
      remoteAddress: '198.51.100.25',
      headers: {
        cookie: `pertexo_invitation_intent=${encodeURIComponent(originalInvitationBinding)}`,
        origin: 'https://api.integration.test',
        'content-type': 'application/json',
        'x-pertexo-invitation-request': 'resolve',
      },
      payload: { token: invitationToken },
    });
    expect(recoveredReplacement.statusCode, recoveredReplacement.payload).toBe(
      201,
    );
    expect(recoveredReplacement.json()).toEqual(lostReplacementBody);
    const invitationBinding = cookieValue(
      Array.isArray(recoveredReplacement.headers['set-cookie'])
        ? recoveredReplacement.headers['set-cookie']
        : [String(recoveredReplacement.headers['set-cookie'])],
      'pertexo_invitation_intent',
    );
    expect(invitationBinding).toBe(lostReplacementBinding);
    resolvedBody = lostReplacementBody;
    await signUp(recipientEmail, 'Invited integration recipient');
    let openStream: ReturnType<typeof openHttpEventStream> | undefined;
    try {
      const recipientCookies = await signIn(recipientEmail);
      const recipientId = (
        await caseFixture.application
          .get<IdentitySessionAuthority>(SESSION_AUTHORITY)
          .authenticate(recipientCookies.rawSession)
      ).userId;
      await withOwnerWorkspace(streamWorkspaceId, (client) =>
        client.query(
          `insert into app.workspace_memberships(workspace_id,user_id,role,status)
           values($1,$2,'viewer','active')`,
          [streamWorkspaceId, recipientId],
        ),
      );
      const beforeAcceptance = await caseFixture.application.inject({
        method: 'GET',
        url: runUrl,
        headers: { cookie: recipientCookies.cookieHeader },
      });
      expect(beforeAcceptance.statusCode, beforeAcceptance.payload).toBe(200);
      if (!caseFixture.application.getHttpServer().listening)
        await caseFixture.application.listen(0, '127.0.0.1');
      const address = caseFixture.application.getHttpServer().address() as {
        port: number;
      };
      openStream = openHttpEventStream(
        address.port,
        `${runUrl}/events`,
        recipientCookies.cookieHeader,
        1,
      );
      await withTimeout(openStream.started, 2_000);

      const ready = await caseFixture.application.inject({
        method: 'POST',
        url: '/v1/invitation-acceptance/session',
        headers: mutationHeaders(recipientCookies, {
          cookie: `${recipientCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
          'x-invitation-csrf-token': resolvedBody.csrfToken,
        }),
        payload: {},
      });
      expect(ready.statusCode, ready.payload).toBe(200);
      const readyBody = ready.json<{
        state: string;
        intentId: string;
        csrfToken: string;
        invitationRevision: number;
      }>();
      expect(readyBody).toMatchObject({
        state: 'ready',
        intentId: resolvedBody.intentId,
        csrfToken: resolvedBody.csrfToken,
        invitationRevision: 1,
      });
      const acceptanceKey = `invitation-accept-${randomUUID()}`;
      const completed = await caseFixture.application.inject({
        method: 'POST',
        url: '/v1/invitation-acceptance/complete',
        headers: mutationHeaders(recipientCookies, {
          cookie: `${recipientCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
          'idempotency-key': acceptanceKey,
          'x-invitation-csrf-token': readyBody.csrfToken,
        }),
        payload: {
          intentId: readyBody.intentId,
          expectedRevision: readyBody.invitationRevision,
        },
      });
      expect(completed.statusCode, completed.payload).toBe(200);
      expect(completed.json()).toMatchObject({
        workspaceId: invitedWorkspaceId,
        membershipCreated: true,
        role: 'viewer',
      });
      const replacementCookies = sessionCookies(
        completed.headers['set-cookie'],
      );
      expect(String(completed.headers['set-cookie'])).not.toContain(
        'pertexo_invitation_intent=;',
      );
      const reconciledWithReplacement = await caseFixture.application.inject({
        method: 'GET',
        url: '/v1/invitation-acceptance',
        headers: {
          cookie: `${replacementCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
        },
      });
      expect(reconciledWithReplacement.statusCode).toBe(200);
      expect(reconciledWithReplacement.json()).toMatchObject({
        state: 'completed',
        workspace: { id: invitedWorkspaceId },
      });
      const oldSession = await caseFixture.application.inject({
        method: 'GET',
        url: runUrl,
        headers: { cookie: recipientCookies.cookieHeader },
      });
      expectProblem(oldSession, 401, 'auth.unauthenticated');
      await withTimeout(openStream.closed, 6_500);

      const recoveryRequired = await caseFixture.application.inject({
        method: 'GET',
        url: '/v1/invitation-acceptance',
        headers: {
          cookie: `pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
        },
      });
      expect(recoveryRequired.statusCode, recoveryRequired.payload).toBe(200);
      expect(recoveryRequired.json()).toMatchObject({
        state: 'sign_in_required',
        intentId: readyBody.intentId,
      });

      const recoveredCookies = await signIn(recipientEmail);
      const reconciledAfterLostCookies = await caseFixture.application.inject({
        method: 'GET',
        url: '/v1/invitation-acceptance',
        headers: {
          cookie: `${recoveredCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
        },
      });
      expect(reconciledAfterLostCookies.statusCode).toBe(200);
      expect(reconciledAfterLostCookies.json()).toMatchObject({
        state: 'completed',
        workspace: { id: invitedWorkspaceId },
      });
      const changedExactRetry = await caseFixture.application.inject({
        method: 'POST',
        url: '/v1/invitation-acceptance/complete',
        headers: mutationHeaders(recoveredCookies, {
          cookie: `${recoveredCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
          'idempotency-key': acceptanceKey,
          'x-invitation-csrf-token': readyBody.csrfToken,
        }),
        payload: {
          intentId: readyBody.intentId,
          expectedRevision: readyBody.invitationRevision + 1,
        },
      });
      expectProblem(changedExactRetry, 409, 'request.idempotency_conflict');
      const historicalRecovery = await caseFixture.application.inject({
        method: 'POST',
        url: '/v1/invitation-acceptance/complete',
        headers: mutationHeaders(recoveredCookies, {
          cookie: `${recoveredCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
          'idempotency-key': `invitation-recovery-${randomUUID()}`,
          'x-invitation-csrf-token': readyBody.csrfToken,
        }),
        payload: {
          intentId: readyBody.intentId,
          expectedRevision: readyBody.invitationRevision + 1,
        },
      });
      expect(historicalRecovery.statusCode, historicalRecovery.payload).toBe(
        200,
      );
      expect(historicalRecovery.json()).toMatchObject({
        replayed: true,
        membershipCreated: true,
      });
      const granted = await caseFixture.application.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: { cookie: replacementCookies.cookieHeader },
      });
      expect(granted.statusCode, granted.payload).toBe(200);
      expect(
        granted
          .json<{ items: { id: string; role: string }[] }>()
          .items.find((item) => item.id === invitedWorkspaceId),
      ).toMatchObject({ id: invitedWorkspaceId, role: 'viewer' });
      const aggregate = await workspaceAggregate(invitedWorkspaceId);
      expect(
        aggregate.events.filter(
          (event) => event.action === 'workspace.invitation_accepted',
        ),
      ).toHaveLength(1);
    } finally {
      openStream?.request.destroy();
    }
  }, 20_000);
}
