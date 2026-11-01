import { describe, expect, it } from 'vitest';

import {
  ConnectionTestInProgressError,
  createInput,
  ownerA,
  randomUUID,
  workspaceA,
} from '../support/connections.js';
import {
  asDatabaseOwner,
  connections,
  newMember,
  registerMembers,
  restrictConnection,
  setMembership,
  suspendUser,
  whileWorkspaceIs,
} from './member-access/world.js';

registerMembers();

type Claim = Readonly<{
  workspaceId: string;
  actorId: string;
  connectionId: string;
  idempotencyKey: string;
  requestHash: string;
  dispatchToken: string;
  secretVersionId: string;
}>;

async function claimed(actorId: string): Promise<Claim> {
  const input = createInput();
  await connections.api.createConnection(input);
  const claim = {
    workspaceId: workspaceA,
    actorId,
    connectionId: input.connectionId,
    idempotencyKey: `claim-${randomUUID()}`,
    requestHash: 'a'.repeat(64),
    dispatchToken: randomUUID(),
    secretVersionId: input.secretVersionId,
  };
  await connections.api.startConnectionTest({
    ...claim,
    expectedProviderKey: 'http',
  });
  return claim;
}

async function dispatched(actorId: string): Promise<Claim> {
  const claim = await claimed(actorId);
  await connections.api.resolveConnectionTestSecret({
    ...claim,
    expectedProviderKey: 'http',
  });
  await connections.api.markConnectionTestDispatched(claim);
  return claim;
}

const complete = (claim: Claim) =>
  connections.api.completeConnectionTest({
    ...claim,
    outcome: { ok: true, httpStatus: 204 },
  });

const retry = (claim: Claim, dispatchToken = randomUUID()) =>
  connections.api.startConnectionTest({
    ...claim,
    expectedProviderKey: 'http',
    dispatchToken,
  });

/** What the claim row holds now: the only thing that says if a test finished. */
async function claimStatus(claim: Claim): Promise<string | undefined> {
  return asDatabaseOwner(workspaceA, async (client) => {
    const { rows } = await client.query<{ status: string }>(
      `select status from app.idempotency_records
       where workspace_id=$1 and operation='connection.test' and resource_id=$2`,
      [workspaceA, claim.connectionId],
    );
    return rows[0]?.status;
  });
}

const LOSSES = [
  {
    loss: 'being removed',
    lose: (actorId: string) => setMembership(actorId, { status: 'removed' }),
  },
  {
    loss: 'being suspended',
    lose: (actorId: string) => setMembership(actorId, { status: 'suspended' }),
  },
  {
    loss: 'being demoted to viewer',
    lose: (actorId: string) => setMembership(actorId, { role: 'viewer' }),
  },
  { loss: 'their account being suspended', lose: suspendUser },
] as const;

describe('a connection test whose member loses access', () => {
  describe.each(LOSSES)('by $loss', ({ lose }) => {
    it('still reports what it found', async () => {
      const actorId = await newMember('builder', 'Tester');
      const claim = await dispatched(actorId);
      await lose(actorId);

      await expect(complete(claim)).resolves.toMatchObject({
        connection: { id: claim.connectionId, status: 'active' },
        outcome: { ok: true, httpStatus: 204 },
      });
      expect(await claimStatus(claim)).toBe('completed');
    });

    it('still lets go of its claim', async () => {
      const actorId = await newMember('builder', 'Tester');
      const claim = await claimed(actorId);
      await lose(actorId);

      await connections.api.abandonConnectionTest(claim);
      expect(await claimStatus(claim)).toBe('failed');
    });
  });

  it('still finishes when a restriction takes the member out', async () => {
    const actorId = await newMember('builder', 'Tester');
    const claim = await dispatched(actorId);
    await restrictConnection(claim.connectionId, []);
    await expect(complete(claim)).resolves.toMatchObject({
      outcome: { ok: true },
    });
  });

  it('can’t start over once access is gone', async () => {
    const actorId = await newMember('builder', 'Tester');
    const claim = await claimed(actorId);
    await connections.api.abandonConnectionTest(claim);
    await setMembership(actorId, { status: 'removed' });
    await expect(retry(claim)).rejects.toThrow('Connection is not visible');
  });
});

describe('finishing a connection test in a workspace that isn’t active', () => {
  it.each(['suspended', 'pending_deletion'] as const)(
    'a %s workspace still lets go of a claim',
    async (status) => {
      const claim = await claimed(ownerA);
      await whileWorkspaceIs(status, () =>
        connections.api.abandonConnectionTest(claim),
      );
      expect(await claimStatus(claim)).toBe('failed');
    },
  );

  // Integrations stay off outside an active workspace, whoever is asking, so the
  // connection doesn't change; the test still reports what it found.
  it.each(['suspended', 'pending_deletion'] as const)(
    'a %s workspace records a healthy answer without changing the connection',
    async (status) => {
      const claim = await dispatched(ownerA);
      const before = await connections.api.getConnection(
        workspaceA,
        claim.connectionId,
      );
      await whileWorkspaceIs(status, async () => {
        await expect(complete(claim)).resolves.toMatchObject({
          outcome: { ok: true },
        });
      });
      expect(await claimStatus(claim)).toBe('completed');
      expect(
        await connections.api.getConnection(workspaceA, claim.connectionId),
      ).toEqual(before);
    },
  );
});

describe('owning the claim is the authority', () => {
  const otherClaims = [
    {
      who: 'a wrong dispatch token',
      other: (claim: Claim) => ({ ...claim, dispatchToken: randomUUID() }),
    },
    {
      who: 'a wrong request hash',
      other: (claim: Claim) => ({ ...claim, requestHash: 'f'.repeat(64) }),
    },
    {
      who: 'a different idempotency key',
      other: (claim: Claim) => ({ ...claim, idempotencyKey: randomUUID() }),
    },
    {
      who: 'another member holding the right token',
      other: (claim: Claim, member: string) => ({ ...claim, actorId: member }),
    },
    {
      who: 'another connection',
      other: (claim: Claim) => ({ ...claim, connectionId: randomUUID() }),
    },
  ];

  describe.each(otherClaims)('$who', ({ other }) => {
    it('can’t complete it, and leaves it for its owner', async () => {
      const member = await newMember('builder', 'Other');
      const claim = await dispatched(ownerA);
      await expect(complete(other(claim, member))).rejects.toBeInstanceOf(
        ConnectionTestInProgressError,
      );
      expect(await claimStatus(claim)).toBe('in_progress');
      await expect(complete(claim)).resolves.toMatchObject({
        outcome: { ok: true },
      });
    });

    it('can’t abandon it, and leaves it for its owner', async () => {
      const member = await newMember('builder', 'Other');
      const claim = await claimed(ownerA);
      await connections.api.abandonConnectionTest(other(claim, member));
      expect(await claimStatus(claim)).toBe('in_progress');
      await connections.api.abandonConnectionTest(claim);
      expect(await claimStatus(claim)).toBe('failed');
    });
  });

  it('a test finishes once: its claim can’t be completed again', async () => {
    const claim = await dispatched(ownerA);
    await complete(claim);
    await expect(complete(claim)).rejects.toBeInstanceOf(
      ConnectionTestInProgressError,
    );
  });

  it('abandoning can’t undo dispatch evidence', async () => {
    const claim = await dispatched(ownerA);
    await connections.api.abandonConnectionTest(claim);
    expect(await claimStatus(claim)).toBe('in_progress');
    await expect(complete(claim)).resolves.toMatchObject({
      outcome: { ok: true },
    });
  });

  it('an answer from the provider needs dispatch evidence', async () => {
    const claim = await claimed(ownerA);
    await expect(complete(claim)).rejects.toThrow(
      'Connection test has no dispatch evidence',
    );
    expect(await claimStatus(claim)).toBe('in_progress');
  });
});

describe('a connection test claim going stale', () => {
  async function agedBy(claim: Claim, seconds: number): Promise<void> {
    await asDatabaseOwner(workspaceA, (client) =>
      client.query(
        `update app.idempotency_records
         set updated_at=clock_timestamp()-make_interval(secs=>$3)
         where workspace_id=$1 and operation='connection.test' and resource_id=$2`,
        [workspaceA, claim.connectionId, seconds],
      ),
    );
  }

  it('can’t be retaken before its two minutes are up', async () => {
    const claim = await claimed(ownerA);
    await agedBy(claim, 110);
    await expect(retry(claim)).rejects.toThrow(
      'Connection test is already in progress',
    );
  });

  it('can be retaken after its two minutes, and its old owner is out', async () => {
    const claim = await claimed(ownerA);
    await agedBy(claim, 130);
    const newToken = randomUUID();
    await expect(retry(claim, newToken)).resolves.toEqual({
      kind: 'dispatch',
      dispatchToken: newToken,
    });

    await connections.api.abandonConnectionTest(claim);
    expect(await claimStatus(claim)).toBe('in_progress');
    await expect(
      connections.api.resolveConnectionTestSecret({
        ...claim,
        expectedProviderKey: 'http',
      }),
    ).rejects.toBeInstanceOf(ConnectionTestInProgressError);
    await expect(complete(claim)).rejects.toBeInstanceOf(
      ConnectionTestInProgressError,
    );
  });

  it('never goes stale once dispatched', async () => {
    const claim = await dispatched(ownerA);
    await agedBy(claim, 130);
    await expect(retry(claim)).rejects.toThrow(
      'Connection test has durable dispatch evidence',
    );
  });
});
