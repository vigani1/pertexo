import { expect, it } from 'vitest';

import { admin, createFamily } from '../../../lifecycle/calls/fixtures.js';
import {
  lend,
  takeBack,
  setStatus,
  usage,
  lowerLimit,
  incomingOwner,
} from './fixture.js';

export function registerLendsOneSlotKeepsTerminal(): void {
  it('lends one slot, keeps its terminal return right, and returns exactly once', async () => {
    const family = await createFamily({ childQueued: true });
    await lowerLimit(family.workspaceId, 2, 1);
    expect(await usage(family.workspaceId)).toMatchObject({
      activeCapacityConsumed: 1,
      activeRuns: 1,
    });
    expect(await lend(family)).toBe(true);
    expect(await usage(family.workspaceId)).toMatchObject({
      activeCapacityConsumed: 1,
      activeRuns: 0,
      reservedActiveSlots: 1,
    });
    expect(await lend(family)).toBe(true);
    await setStatus(family.workspaceId, family.childRunId, 'running');
    expect(await usage(family.workspaceId)).toMatchObject({
      activeCapacityConsumed: 1,
      activeRuns: 1,
      reservedActiveSlots: 0,
    });
    expect(await takeBack(family)).toBe(false);
    await setStatus(family.workspaceId, family.childRunId, 'succeeded');
    expect(await usage(family.workspaceId)).toMatchObject({
      activeCapacityConsumed: 1,
      activeRuns: 0,
      reservedActiveSlots: 1,
    });
    expect(await incomingOwner(family)).toEqual([
      { workflow_run_id: family.childRunId, borrowed_call_id: family.callId },
    ]);
    expect(await takeBack(family)).toBe(true);
    expect(await usage(family.workspaceId)).toMatchObject({
      activeCapacityConsumed: 1,
      activeRuns: 1,
      reservedActiveSlots: 0,
    });
    expect(await takeBack(family)).toBe(false);
    expect(await incomingOwner(family)).toEqual([]);
  });

  it('conserves all five default slots through handoff and a later limit reduction', async () => {
    const first = await createFamily({ childQueued: true });
    const families = [first];
    for (let index = 1; index < 5; index += 1)
      families.push(
        await createFamily({
          childQueued: true,
          workspaceId: first.workspaceId,
        }),
      );
    expect((await usage(first.workspaceId)).activeCapacityConsumed).toBe(5);
    for (const family of families) expect(await lend(family)).toBe(true);
    expect(await usage(first.workspaceId)).toMatchObject({
      activeCapacityConsumed: 5,
      activeRuns: 0,
      reservedActiveSlots: 5,
    });
    await lowerLimit(first.workspaceId, 2, 1);
    for (const family of families)
      await setStatus(first.workspaceId, family.childRunId, 'running');
    expect(await usage(first.workspaceId)).toMatchObject({
      activeCapacityConsumed: 5,
      activeRuns: 5,
      reservedActiveSlots: 0,
    });
    for (const family of families) {
      await setStatus(first.workspaceId, family.childRunId, 'succeeded');
      expect(await takeBack(family)).toBe(true);
      expect((await usage(first.workspaceId)).activeCapacityConsumed).toBe(5);
    }
  });

  it('starts a newly accepted borrower under a lower policy using an existing slot', async () => {
    const root = await createFamily({ childQueued: true });
    for (let index = 1; index < 5; index += 1)
      await createFamily({ childQueued: true, workspaceId: root.workspaceId });
    await lowerLimit(root.workspaceId, 2, 1);
    const fresh = await createFamily({
      childQueued: true,
      workspaceId: root.workspaceId,
      parentDays: 1,
    });
    await admin.query(
      'update app.workflow_calls set parent_run_id=$2,invocation_key=$3 where id=$1',
      [fresh.callId, root.parentRunId, 'fresh-call'],
    );
    const policy = await admin.query<{ execution_entitlement_version: number }>(
      'select execution_entitlement_version from app.workflow_runs where id=$1',
      [fresh.childRunId],
    );
    expect(policy.rows[0]?.execution_entitlement_version).toBe(2);
    expect(await lend({ ...fresh, parentRunId: root.parentRunId })).toBe(true);
    await setStatus(root.workspaceId, fresh.childRunId, 'running');
    expect((await usage(root.workspaceId)).activeCapacityConsumed).toBe(5);
    await setStatus(root.workspaceId, fresh.childRunId, 'succeeded');
    expect(await takeBack({ ...fresh, parentRunId: root.parentRunId })).toBe(
      true,
    );
    expect((await usage(root.workspaceId)).activeCapacityConsumed).toBe(5);
  });

  it('passes a nested loan down and returns it one direct level at a time', async () => {
    const outer = await createFamily({ childQueued: true });
    await lowerLimit(outer.workspaceId, 2, 1);
    expect(await lend(outer)).toBe(true);
    await setStatus(outer.workspaceId, outer.childRunId, 'running');
    const inner = await createFamily({
      childQueued: true,
      workspaceId: outer.workspaceId,
      parentDays: 1,
    });
    // The inner relation belongs to the existing middle run, not another live parent.
    await admin.query(
      'update app.workflow_calls set parent_run_id=$2 where id=$1',
      [inner.callId, outer.childRunId],
    );
    const nested = { ...inner, parentRunId: outer.childRunId };
    expect(await lend(nested)).toBe(true);
    expect(await incomingOwner(outer)).toEqual([
      { workflow_run_id: inner.childRunId, borrowed_call_id: inner.callId },
    ]);
    expect(await takeBack(outer)).toBe(false);
    await setStatus(outer.workspaceId, inner.childRunId, 'running');
    await setStatus(outer.workspaceId, inner.childRunId, 'succeeded');
    expect(await takeBack(nested)).toBe(true);
    expect(await incomingOwner(outer)).toEqual([
      { workflow_run_id: outer.childRunId, borrowed_call_id: outer.callId },
    ]);
    expect((await usage(outer.workspaceId)).activeCapacityConsumed).toBe(1);
    await setStatus(outer.workspaceId, outer.childRunId, 'succeeded');
    expect(await takeBack(outer)).toBe(true);
    expect(await incomingOwner(outer)).toEqual([]);
    expect((await usage(outer.workspaceId)).activeCapacityConsumed).toBe(1);
  });

  it('unwinds a canceled nested chain without releasing the slot between returns', async () => {
    const outer = await createFamily({ childQueued: true });
    expect(await lend(outer)).toBe(true);
    await setStatus(outer.workspaceId, outer.childRunId, 'running');
    const inner = await createFamily({
      childQueued: true,
      workspaceId: outer.workspaceId,
      parentDays: 1,
    });
    await admin.query(
      'update app.workflow_calls set parent_run_id=$2 where id=$1',
      [inner.callId, outer.childRunId],
    );
    const nested = { ...inner, parentRunId: outer.childRunId };
    expect(await lend(nested)).toBe(true);
    await setStatus(outer.workspaceId, inner.childRunId, 'running');
    await setStatus(outer.workspaceId, outer.parentRunId, 'canceled');
    await setStatus(outer.workspaceId, outer.childRunId, 'canceled');
    expect(await takeBack(outer)).toBe(false);
    expect((await usage(outer.workspaceId)).activeCapacityConsumed).toBe(1);
    await setStatus(outer.workspaceId, inner.childRunId, 'canceled');
    expect(await takeBack(nested)).toBe(true);
    expect(await incomingOwner(outer)).toEqual([
      { workflow_run_id: outer.childRunId, borrowed_call_id: outer.callId },
    ]);
    expect((await usage(outer.workspaceId)).activeCapacityConsumed).toBe(1);
    expect(await takeBack(outer)).toBe(true);
    expect((await usage(outer.workspaceId)).activeCapacityConsumed).toBe(0);
  });

  it('does not lend a second parallel call until the first has returned', async () => {
    const first = await createFamily({ childQueued: true });
    const other = await createFamily({
      childQueued: true,
      workspaceId: first.workspaceId,
      parentDays: 1,
    });
    await admin.query(
      'update app.workflow_calls set parent_run_id=$2,invocation_key=$3 where id=$1',
      [other.callId, first.parentRunId, 'parallel-call'],
    );
    const parallel = { ...other, parentRunId: first.parentRunId };
    expect(await lend(first)).toBe(true);
    expect(await lend(parallel)).toBe(false);
    expect((await usage(first.workspaceId)).activeCapacityConsumed).toBe(1);
    await setStatus(first.workspaceId, first.childRunId, 'succeeded');
    expect(await takeBack(first)).toBe(true);
    expect(await lend(parallel)).toBe(true);
    expect((await usage(first.workspaceId)).activeCapacityConsumed).toBe(1);
  });

  it('releases a closed root only after its terminal borrower settles', async () => {
    const family = await createFamily({ childQueued: true });
    expect(await lend(family)).toBe(true);
    await setStatus(family.workspaceId, family.childRunId, 'running');
    await setStatus(family.workspaceId, family.parentRunId, 'canceled');
    expect(await takeBack(family)).toBe(false);
    expect((await usage(family.workspaceId)).activeCapacityConsumed).toBe(1);
    await setStatus(family.workspaceId, family.childRunId, 'canceled');
    expect(await takeBack(family)).toBe(true);
    expect((await usage(family.workspaceId)).activeCapacityConsumed).toBe(0);
  });
}
