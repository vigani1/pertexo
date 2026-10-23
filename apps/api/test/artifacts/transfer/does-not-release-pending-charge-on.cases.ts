import { expect, it } from 'vitest';

import { requestMetadata, begin, signedPut, fixture } from './fixture.js';

export function registerDoesNotReleasePendingChargeOn(): void {
  it('does not release a pending charge on expiry and releases exactly once after deletion', async () => {
    const owner = await fixture.login('owner');
    const body = Buffer.from('retention charge proof');
    const metadata = requestMetadata(body);
    const started = await begin(fixture, owner, metadata);
    const artifactId = started.artifact.id;
    const uploaded = await signedPut(started.upload, body);
    expect(uploaded.ok).toBe(true);
    await expect(
      fixture.verificationStore.validateDirectUpload({
        ...metadata,
        artifactId,
        workspaceId: fixture.workspaceId,
      }),
    ).resolves.toMatchObject({
      artifactId,
      workspaceId: fixture.workspaceId,
      byteLength: body.length,
      mediaType: metadata.mediaType,
      sha256: metadata.sha256,
    });
    await fixture.expireArtifact(artifactId);
    const held = await fixture.readCapacity();
    expect(held.chargedCount).toBeGreaterThan(0);
    expect((await fixture.readArtifact(artifactId))?.status).toBe('pending');

    await fixture.withOwner(async (client) => {
      await client.query(
        `update app.artifacts set status='deleting',updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2`,
        [fixture.workspaceId, artifactId],
      );
    });
    expect(await fixture.readCapacity()).toEqual(held);

    await fixture.verificationStore.delete({
      artifactId,
      workspaceId: fixture.workspaceId,
    });
    await expect(
      fixture.verificationStore.head({
        artifactId,
        workspaceId: fixture.workspaceId,
      }),
    ).resolves.toBeNull();
    await fixture.withOwner(async (client) => {
      await client.query(
        `update app.artifacts
            set status='deleted',deleted_at=clock_timestamp(),updated_at=clock_timestamp()
          where workspace_id=$1 and id=$2`,
        [fixture.workspaceId, artifactId],
      );
    });
    const released = await fixture.readCapacity();
    expect(released.chargedCount).toBe(held.chargedCount - 1);
    expect(released.chargedBytes).toBe(held.chargedBytes - body.length);

    await fixture.verificationStore.delete({
      artifactId,
      workspaceId: fixture.workspaceId,
    });
    expect(await fixture.readCapacity()).toEqual(released);
  });
}
