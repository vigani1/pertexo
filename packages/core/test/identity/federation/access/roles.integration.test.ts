import { describe, expect, it } from 'vitest';

import {
  READS,
  admin,
  commands,
  db,
  directory,
  federation,
  organization,
  outcome,
  ownerActions,
  withoutAuthority,
} from './fixture.js';

describe('who can read sign-in and directory settings', () => {
  it('answers an owner and an admin, and denies everyone else', async () => {
    const f = await organization();
    const adminId = await admin(f);
    const denied = await withoutAuthority(f);
    for (const [name, read] of READS) {
      expect(await outcome(read(f.scope)), `${name}: owner`).toBe('answered');
      expect(
        await outcome(read({ workspaceId: f.control, actorId: adminId })),
        `${name}: admin`,
      ).toBe(name === 'directory adoption' ? 'forbidden' : 'answered');
      for (const [who, actorId] of denied)
        expect(
          await outcome(read({ workspaceId: f.control, actorId })),
          `${name}: ${who}`,
        ).toBe('access denied');
    }
  }, 60_000);

  it('lets only the owner manage, and in the directory only from the control workspace', async () => {
    const f = await organization();
    const adminId = await admin(f);
    const asAdmin = { workspaceId: f.control, actorId: adminId };
    const fromLinked = { workspaceId: f.linked, actorId: f.owner.id };
    expect((await federation.settings(f.scope)).canManage).toBe(true);
    expect((await federation.settings(asAdmin)).canManage).toBe(false);
    expect((await federation.settings(fromLinked)).canManage).toBe(false);
    expect((await directory.settings(f.scope)).canManage).toBe(true);
    expect((await directory.settings(asAdmin)).canManage).toBe(false);
    expect((await directory.settings(fromLinked)).canManage).toBe(false);
  }, 60_000);

  it('offers an owner with no organization yet the way to manage', async () => {
    const owner = await db.user('New owner'),
      workspaceId = await db.workspace(owner.id);
    await expect(
      federation.settings({ workspaceId, actorId: owner.id }),
    ).resolves.toMatchObject({ canManage: true, organization: null });
    await expect(
      directory.settings({ workspaceId, actorId: owner.id }),
    ).rejects.toHaveProperty('reason', 'not_found');
  });

  it('lists every linked workspace, read from inside one of them', async () => {
    const f = await organization();
    const settings = await federation.settings({
      workspaceId: f.linked,
      actorId: f.owner.id,
    });
    expect(
      settings.organization?.workspaces
        .map((entry) => entry.workspaceId)
        .sort(),
    ).toEqual([f.control, f.linked].sort());
  }, 60_000);
});

describe('what only an owner can do', () => {
  it('tells an admin an owner is required, and denies anyone below', async () => {
    const f = await organization();
    const adminId = await admin(f);
    const denied = await withoutAuthority(f);
    for (const [name, act] of ownerActions(f)) {
      expect(
        await outcome(act({ workspaceId: f.control, actorId: adminId })),
        `${name}: admin`,
      ).toBe('owner_required');
      for (const [who, actorId] of denied)
        expect(
          await outcome(act({ workspaceId: f.control, actorId })),
          `${name}: ${who}`,
        ).toBe('access denied');
    }
    for (const [name, act] of commands(f)) {
      expect(
        await outcome(act({ workspaceId: f.control, actorId: adminId })),
        `${name}: admin`,
      ).not.toBe('answered');
      for (const [who, actorId] of denied)
        expect(
          await outcome(act({ workspaceId: f.control, actorId })),
          `${name}: ${who}`,
        ).not.toBe('answered');
    }
  }, 60_000);

  it('sends an owner in a linked workspace back to the control workspace', async () => {
    const f = await organization();
    const fromLinked = { workspaceId: f.linked, actorId: f.owner.id };
    const [challenge, verification, providerTest] = ownerActions(f);
    expect(await outcome(challenge[1](fromLinked))).toBe('owner_required');
    expect(await outcome(verification[1](fromLinked))).toBe('owner_required');
    expect(await outcome(providerTest[1](fromLinked))).toBe('unavailable');
  }, 60_000);

  it('answers the owner, or these prove nothing', async () => {
    const f = await organization();
    for (const [name, act] of ownerActions(f))
      expect(await outcome(act(f.scope)), name).toBe('answered');
  }, 60_000);
});
