import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InvitationAcceptanceConflictError } from '../../../src/tenant-access/index.js';
import {
  admin,
  closeWorld,
  identities,
  invitation,
  openWorld,
  person,
  team,
} from './world.js';

beforeAll(openWorld);
afterAll(closeWorld);

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');

async function emailOf(userId: string) {
  const found = await admin.query<{ email: string }>(
    'select email from app.users where id=$1',
    [userId],
  );
  return found.rows[0]?.email ?? '';
}

async function session(userId: string) {
  const id = randomUUID();
  await admin.query(
    "insert into app.auth_sessions(id,user_id,token,expires_at) values($1,$2,$3,clock_timestamp()+interval '1 hour')",
    [id, userId, randomUUID()],
  );
  return id;
}

const memberRow = async (workspaceId: string, userId: string) =>
  (
    await admin.query<{ role: string; status: string }>(
      'select role,status from app.workspace_memberships where workspace_id=$1 and user_id=$2',
      [workspaceId, userId],
    )
  ).rows[0];

/** What a browser does with a link: open it, under a binding of its own. */
function open(workspaceId: string, invitationId: string, tokenDigest: string) {
  const intentId = randomUUID();
  const bindingDigest = digest(randomUUID());
  return {
    intentId,
    bindingDigest,
    opened: identities.resolveInvitationAcceptance({
      workspaceId,
      invitationId,
      tokenDigest,
      intentId,
      bindingDigest,
      csrfDigest: digest(randomUUID()),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    }),
  };
}

async function invited() {
  const world = await team();
  const recipient = await person();
  const tokenDigest = digest(randomUUID());
  const created = await identities.createWorkspaceInvitation({
    ...invitation(world.workspaceId, world.owner, await emailOf(recipient)),
    tokenDigest,
  });
  return {
    ...world,
    recipient,
    tokenDigest,
    invitationId: created.invitation.id,
    revision: created.invitation.revision,
  };
}

async function prove(
  workspaceId: string,
  intentId: string,
  bindingDigest: string,
  userId: string,
) {
  return identities.recordInvitationAcceptanceProof({
    workspaceId,
    intentId,
    bindingDigest,
    userId,
    sessionId: await session(userId),
    verifiedEmail: await emailOf(userId),
    verifiedAt: new Date(),
  });
}

const complete = (
  workspaceId: string,
  intentId: string,
  actorUserId: string,
  invitationRevision = 1,
) =>
  identities.completeInvitationAcceptance({
    workspaceId,
    intentId,
    invitationRevision,
    actorUserId,
    idempotencyKey: randomUUID(),
    replacementSession: {
      id: randomUUID(),
      token: digest(randomUUID()),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

describe('a link that has gone stale', () => {
  it('does not open an expired invitation', async () => {
    const { workspaceId, invitationId, tokenDigest } = await invited();
    await admin.query(
      `update app.workspace_invitations set expires_at=clock_timestamp()-interval '1 minute' where id=$1`,
      [invitationId],
    );
    expect(
      await open(workspaceId, invitationId, tokenDigest).opened,
    ).toBeNull();
    const { rows } = await admin.query<{ status: string }>(
      'select status from app.workspace_invitations where id=$1',
      [invitationId],
    );
    expect(rows).toEqual([{ status: 'expired' }]);
  });

  it('does not open with the token a resend replaced, and the new one does', async () => {
    const { workspaceId, owner, invitationId, tokenDigest, revision } =
      await invited();
    await admin.query(
      "update app.workspace_invitation_delivery_attempts set status='failed',failure_code='rejected' where invitation_id=$1",
      [invitationId],
    );
    const replacement = digest(randomUUID());
    await identities.resendWorkspaceInvitation({
      workspaceId,
      actorUserId: owner,
      invitationId,
      expectedRevision: revision,
      idempotencyKey: randomUUID(),
      tokenDigest: replacement,
      sealedToken: invitation(workspaceId, owner).sealedToken,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(
      await open(workspaceId, invitationId, tokenDigest).opened,
    ).toBeNull();
    expect(
      await open(workspaceId, invitationId, replacement).opened,
    ).toMatchObject({ invitationStatus: 'pending' });
  });

  it('does not let a revoked invitation be finished, even by a journey already open', async () => {
    const {
      workspaceId,
      owner,
      recipient,
      invitationId,
      tokenDigest,
      revision,
    } = await invited();
    const journey = open(workspaceId, invitationId, tokenDigest);
    await journey.opened;
    await prove(
      workspaceId,
      journey.intentId,
      journey.bindingDigest,
      recipient,
    );
    await identities.revokeWorkspaceInvitation({
      workspaceId,
      actorUserId: owner,
      invitationId,
      expectedRevision: revision,
      idempotencyKey: randomUUID(),
    });
    await expect(
      complete(workspaceId, journey.intentId, recipient),
    ).rejects.toBeInstanceOf(InvitationAcceptanceConflictError);
    expect(await memberRow(workspaceId, recipient)).toBeUndefined();
  });
});

describe('a token used twice', () => {
  it('adds one membership, and a second person with the same link gets nothing', async () => {
    const { workspaceId, recipient, invitationId, tokenDigest } =
      await invited();
    const first = open(workspaceId, invitationId, tokenDigest);
    await first.opened;
    await prove(workspaceId, first.intentId, first.bindingDigest, recipient);
    await expect(
      complete(workspaceId, first.intentId, recipient),
    ).resolves.toMatchObject({ membershipCreated: true });

    const someoneElse = await person();
    const second = open(workspaceId, invitationId, tokenDigest);
    const reopened = await second.opened;
    expect(reopened?.invitationStatus).not.toBe('pending');
    await expect(
      complete(workspaceId, second.intentId, someoneElse),
    ).rejects.toBeInstanceOf(InvitationAcceptanceConflictError);
    expect(await memberRow(workspaceId, someoneElse)).toBeUndefined();

    const members = await admin.query(
      "select 1 from app.workspace_memberships where workspace_id=$1 and user_id=$2 and status='active'",
      [workspaceId, recipient],
    );
    expect(members.rowCount).toBe(1);
  });
});

describe('the wrong person accepting', () => {
  it('marks the journey wrong_account and adds no one', async () => {
    const { workspaceId, invitationId, tokenDigest } = await invited();
    const stranger = await person();
    const journey = open(workspaceId, invitationId, tokenDigest);
    await journey.opened;
    await expect(
      prove(workspaceId, journey.intentId, journey.bindingDigest, stranger),
    ).resolves.toMatchObject({ status: 'wrong_account' });
    await expect(
      complete(workspaceId, journey.intentId, stranger),
    ).rejects.toBeInstanceOf(InvitationAcceptanceConflictError);
    expect(await memberRow(workspaceId, stranger)).toBeUndefined();
  });

  it('cannot finish a journey someone else proved', async () => {
    const { workspaceId, recipient, invitationId, tokenDigest } =
      await invited();
    const stranger = await person();
    const journey = open(workspaceId, invitationId, tokenDigest);
    await journey.opened;
    await prove(
      workspaceId,
      journey.intentId,
      journey.bindingDigest,
      recipient,
    );
    await expect(
      complete(workspaceId, journey.intentId, stranger),
    ).rejects.toBeInstanceOf(InvitationAcceptanceConflictError);
    expect(await memberRow(workspaceId, stranger)).toBeUndefined();
    expect(await memberRow(workspaceId, recipient)).toBeUndefined();
  });
});

describe('ending an invitation', () => {
  const intentStatuses = async (invitationId: string) =>
    (
      await admin.query<{ status: string }>(
        'select status from app.workspace_invitation_acceptance_intents where invitation_id=$1 order by status',
        [invitationId],
      )
    ).rows.map(({ status }) => status);

  const sealedDeliveries = async (invitationId: string) =>
    (
      await admin.query<{ status: string; token_ciphertext: string | null }>(
        'select status,token_ciphertext from app.workspace_invitation_delivery_attempts where invitation_id=$1',
        [invitationId],
      )
    ).rows;

  async function withEveryIntent(world: Awaited<ReturnType<typeof invited>>) {
    const { workspaceId, invitationId, tokenDigest, recipient } = world;
    const pending = open(workspaceId, invitationId, tokenDigest);
    await pending.opened;
    const verified = open(workspaceId, invitationId, tokenDigest);
    await verified.opened;
    await prove(
      workspaceId,
      verified.intentId,
      verified.bindingDigest,
      recipient,
    );
    const wrong = open(workspaceId, invitationId, tokenDigest);
    await wrong.opened;
    await prove(
      workspaceId,
      wrong.intentId,
      wrong.bindingDigest,
      await person(),
    );
    return { pending, verified, wrong };
  }

  it('by revoking retires open journeys, cancels deliveries and scrubs the sealed token', async () => {
    const world = await invited();
    await withEveryIntent(world);
    await identities.revokeWorkspaceInvitation({
      workspaceId: world.workspaceId,
      actorUserId: world.owner,
      invitationId: world.invitationId,
      expectedRevision: world.revision,
      idempotencyKey: randomUUID(),
    });
    expect(new Set(await intentStatuses(world.invitationId))).toEqual(
      new Set(['superseded']),
    );
    expect(await sealedDeliveries(world.invitationId)).toEqual([
      expect.objectContaining({ status: 'canceled', token_ciphertext: null }),
    ]);
  });

  it('by expiring retires open journeys, cancels deliveries and scrubs the sealed token', async () => {
    const world = await invited();
    await withEveryIntent(world);
    await admin.query(
      `update app.workspace_invitations set expires_at=clock_timestamp()-interval '1 minute' where id=$1`,
      [world.invitationId],
    );
    await identities.listWorkspaceInvitations(world.workspaceId, world.owner);
    expect(new Set(await intentStatuses(world.invitationId))).toEqual(
      new Set(['superseded']),
    );
    expect(await sealedDeliveries(world.invitationId)).toEqual([
      expect.objectContaining({ token_ciphertext: null }),
    ]);
  });

  it('leaves a completed or abandoned journey as it was', async () => {
    const world = await invited();
    const { workspaceId, invitationId, tokenDigest, recipient } = world;
    const abandoned = open(workspaceId, invitationId, tokenDigest);
    await abandoned.opened;
    await admin.query(
      "update app.workspace_invitation_acceptance_intents set status='abandoned' where id=$1",
      [abandoned.intentId],
    );
    const finished = open(workspaceId, invitationId, tokenDigest);
    await finished.opened;
    await prove(
      workspaceId,
      finished.intentId,
      finished.bindingDigest,
      recipient,
    );
    await complete(workspaceId, finished.intentId, recipient);
    const before = await intentStatuses(invitationId);
    expect(before).toContain('completed');
    await identities.listWorkspaceInvitations(workspaceId, world.owner);
    expect(await intentStatuses(invitationId)).toEqual(before);
  });

  it('a resend replaces the token, but not while a delivery is unresolved', async () => {
    const { workspaceId, owner, invitationId, revision } = await invited();
    const resend = (key = randomUUID()) =>
      identities.resendWorkspaceInvitation({
        workspaceId,
        actorUserId: owner,
        invitationId,
        expectedRevision: revision,
        idempotencyKey: key,
        tokenDigest: digest(randomUUID()),
        sealedToken: invitation(workspaceId, owner).sealedToken,
        expiresAt: new Date(Date.now() + 60_000),
      });
    await expect(resend()).rejects.toMatchObject({
      reason: 'delivery_unresolved',
    });
    await admin.query(
      "update app.workspace_invitation_delivery_attempts set status='failed',failure_code='rejected' where invitation_id=$1",
      [invitationId],
    );
    await expect(resend()).resolves.toMatchObject({
      invitation: { revision: revision + 1, status: 'pending' },
    });
  });
});
