import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { runs, busyWorkspace, inWorkspace } from './fixture.js';

export function registerChargesPendingAvailableDeletingArtifacts(): void {
  it('charges pending, available and deleting artifacts until completed deletion; zero limits remain zero', async () => {
    const artifact = randomUUID();
    await inWorkspace('api', busyWorkspace, {
      text: `insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at)
      values($2::uuid,$1::uuid,'user-upload','workspaces/'||$1::uuid::text||'/artifacts/'||$2::uuid::text,'text/plain',123,repeat('a',64),'pending',now()+interval '1 hour')`,
      values: [busyWorkspace, artifact],
    });
    for (const state of ['pending', 'available', 'deleting']) {
      if (state !== 'pending')
        await inWorkspace('api', busyWorkspace, {
          text: 'update app.artifacts set status=$3,finalized_at=coalesce(finalized_at,now()) where workspace_id=$1 and id=$2',
          values: [busyWorkspace, artifact, state],
        });
      expect(
        (await runs.usageCapacity({ workspaceId: busyWorkspace })).artifacts,
      ).toMatchObject({
        chargedBytes: '123',
        chargedCount: 1,
        source: 'stored',
      });
    }
    await inWorkspace('owner', busyWorkspace, {
      text: 'update app.workspace_artifact_capacity set byte_limit=0,artifact_count_limit=0 where workspace_id=$1',
      values: [busyWorkspace],
    });
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).artifacts,
    ).toEqual({
      chargedBytes: '123',
      byteLimit: '0',
      chargedCount: 1,
      artifactCountLimit: 0,
      source: 'stored',
    });
    await inWorkspace('api', busyWorkspace, {
      text: "update app.artifacts set status='deleted',deleted_at=now() where workspace_id=$1 and id=$2",
      values: [busyWorkspace, artifact],
    });
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).artifacts
        .chargedBytes,
    ).toBe('0');
    await inWorkspace('owner', busyWorkspace, {
      text: 'update app.workspace_artifact_capacity set byte_limit=9223372036854775807 where workspace_id=$1',
      values: [busyWorkspace],
    });
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).artifacts
        .byteLimit,
    ).toBe('9223372036854775807');
  });
}
