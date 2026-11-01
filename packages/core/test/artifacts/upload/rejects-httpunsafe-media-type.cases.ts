import { expect, it } from 'vitest';

import {
  ArtifactQuotaExceededError,
  ArtifactUploadIdempotencyConflictError,
} from '../../../src/artifacts/uploads/input.js';

import {
  database,
  workspaceId,
  actor,
  ownerTransaction,
  setCapacity,
  readCapacity,
} from './fixture.js';

export function registerRejectsHTTPUnsafeMediaType(): void {
  it.each([
    'application/js\u000bon',
    'application/js\u001fon',
    'application/js\u007fon',
    'application/js\u0100on',
  ])(
    'rejects an HTTP-unsafe media type before reserving capacity %#',
    async (mediaType) => {
      await expect(
        database.beginUpload({
          actor: actor(),
          byteLength: 17,
          idempotencyKey: 'artifact-upload-invalid-media-type',
          mediaType,
          sha256: 'a'.repeat(64),
          workspaceId,
        }),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'artifacts_media_type_format',
      });
      await expect(readCapacity()).resolves.toEqual({
        chargedBytes: 0,
        chargedCount: 0,
      });
    },
  );

  it('atomically claims idempotency, creates scoped metadata and replays exact retries', async () => {
    const input = {
      actor: actor(),
      byteLength: 17,
      idempotencyKey: 'artifact-upload-replay',
      mediaType: 'application/octet-stream',
      sha256: 'a'.repeat(64),
      workspaceId,
    } as const;
    const first = await database.beginUpload(input);
    const replay = await database.beginUpload(input);

    expect(first.replayed).toBe(false);
    expect(first.artifact).toMatchObject({
      byteLength: 17,
      mediaType: input.mediaType,
      purpose: 'user-upload',
      sha256: input.sha256,
      status: 'pending',
      storageKey: `workspaces/${workspaceId}/artifacts/${first.artifact.id}`,
      workspaceId,
    });
    expect(replay).toEqual({ artifact: first.artifact, replayed: true });
    await expect(
      database.beginUpload({
        ...input,
        byteLength: 18,
      }),
    ).rejects.toBeInstanceOf(ArtifactUploadIdempotencyConflictError);
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 17,
      chargedCount: 1,
    });
  });

  it('sets the pending deadline from the database clock at fifteen minutes', async () => {
    const databaseTime = () =>
      ownerTransaction(async (client) => {
        const result = await client.query<{ observed_at: Date }>(
          'select clock_timestamp() observed_at',
        );
        const observed = result.rows[0]?.observed_at;
        if (observed === undefined)
          throw new Error('Database clock did not return a timestamp');
        return observed;
      });
    const before = await databaseTime();
    const created = await database.beginUpload({
      actor: actor(),
      byteLength: 19,
      idempotencyKey: 'artifact-upload-deadline',
      mediaType: 'application/octet-stream',
      sha256: 'e'.repeat(64),
      workspaceId,
    });
    const after = await databaseTime();
    const deadline = created.artifact.expiresAt.getTime();
    const expectedLowerBound = before.getTime() + 15 * 60 * 1_000;
    const expectedUpperBound = after.getTime() + 15 * 60 * 1_000;

    expect(deadline).toBeGreaterThanOrEqual(expectedLowerBound);
    expect(deadline).toBeLessThanOrEqual(expectedUpperBound);
    expect(created.artifact.expiresAt.getTime()).toBeGreaterThan(
      created.artifact.createdAt.getTime(),
    );
  });

  it('serializes concurrent retries for one idempotency key into one charge', async () => {
    const input = {
      actor: actor(),
      byteLength: 29,
      idempotencyKey: 'artifact-upload-concurrent-replay',
      mediaType: 'application/octet-stream',
      sha256: 'f'.repeat(64),
      workspaceId,
    } as const;
    const attempts = await Promise.all([
      database.beginUpload(input),
      database.beginUpload(input),
    ]);

    expect(attempts.map((attempt) => attempt.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(attempts[0].artifact.id).toBe(attempts[1].artifact.id);
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 29,
      chargedCount: 1,
    });
  });

  it('serializes quota races and rolls failed reservations back', async () => {
    await setCapacity(4, 1);
    const base = {
      actor: actor(),
      byteLength: 4,
      mediaType: 'application/octet-stream',
      sha256: 'b'.repeat(64),
      workspaceId,
    } as const;
    const attempts = await Promise.allSettled([
      database.beginUpload({ ...base, idempotencyKey: 'quota-race-1' }),
      database.beginUpload({ ...base, idempotencyKey: 'quota-race-2' }),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      attempts.filter(
        (attempt) =>
          attempt.status === 'rejected' &&
          attempt.reason instanceof ArtifactQuotaExceededError,
      ),
    ).toHaveLength(1);
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 4,
      chargedCount: 1,
    });
  });

  it('rolls back a failed quota claim without leaving an idempotency record', async () => {
    await setCapacity(0, 0);
    const input = {
      actor: actor(),
      byteLength: 1,
      idempotencyKey: 'artifact-upload-quota-failure',
      mediaType: 'application/octet-stream',
      sha256: '1'.repeat(64),
      workspaceId,
    } as const;

    await expect(database.beginUpload(input)).rejects.toBeInstanceOf(
      ArtifactQuotaExceededError,
    );
    await expect(
      ownerTransaction(async (client) => {
        const result = await client.query<{ count: string }>(
          `select count(*)::text as count
             from app.idempotency_records
            where workspace_id=$1 and operation='artifact.upload'`,
          [workspaceId],
        );
        return Number(result.rows[0]?.count ?? 0);
      }),
    ).resolves.toBe(0);
    await expect(readCapacity()).resolves.toEqual({
      chargedBytes: 0,
      chargedCount: 0,
    });
  });
}
