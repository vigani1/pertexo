import type { ArtifactStore } from '@pertexo/artifact-store';
import type {
  CoordinatorRunStore,
  NativeAttemptArtifactMetadata,
} from '@pertexo/database/execution';
import { describe, expect, it, vi } from 'vitest';
import { createCoordinatorResultValuePreparation } from '../src/execution/coordinator-result-value-preparation.js';
import {
  WORKSPACE_ID,
  RUN_ID,
  VERSION_ID,
  OUTBOX_EVENT_ID,
} from './support/node-attempt-handler.fixture.js';

const owner = {
  kind: 'run_result' as const,
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  workflowVersionId: VERSION_ID,
  expectedRevision: 4,
  resultRevision: 5,
  resultIdentity: 'b'.repeat(64),
  delivery: { outboxEventId: OUTBOX_EVENT_ID, payloadChecksum: 'a'.repeat(64) },
};

describe('coordinator result value preparation through the existing reserved writer', () => {
  it('uploads canonical bytes once, finalizes the same candidate and reuses an available exact retry', async () => {
    let reservation: NativeAttemptArtifactMetadata | undefined;
    let bytes: Buffer | undefined;
    const reserve = vi.fn<
      NonNullable<CoordinatorRunStore['reserveNativeResultArtifact']>
    >((input) => {
      expect(input.owner).toEqual(owner);
      reservation ??= {
        artifactId: '88888888-8888-4888-8888-888888888888',
        workspaceId: WORKSPACE_ID,
        byteLength: input.byteLength,
        sha256: input.sha256,
        mediaType: input.mediaType,
        available: false,
      };
      return Promise.resolve(reservation);
    });
    const assertReserved = vi.fn<
      NonNullable<CoordinatorRunStore['assertNativeResultArtifactReserved']>
    >((input) => {
      expect(input.reserved).toEqual(reservation);
      expect(input.signal).toBe(signal);
      return Promise.resolve();
    });
    const finalize = vi.fn<
      NonNullable<CoordinatorRunStore['finalizeNativeResultArtifact']>
    >((input) => {
      expect(input.reserved).toEqual(reservation);
      if (reservation === undefined) throw new Error('Missing test candidate');
      reservation = { ...reservation, available: true };
      return Promise.resolve();
    });
    const put = vi.fn<ArtifactStore['put']>(async (input) => {
      expect(assertReserved).toHaveBeenCalledOnce();
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) {
        if (!(chunk instanceof Uint8Array))
          throw new Error('Unexpected test stream chunk');
        chunks.push(Buffer.from(chunk));
      }
      bytes = Buffer.concat(chunks);
      return {
        artifactId: input.artifactId,
        workspaceId: input.workspaceId,
        byteLength: input.byteLength,
        sha256: input.sha256,
        mediaType: input.mediaType,
      };
    });
    const preparation = createCoordinatorResultValuePreparation(
      {
        reserveNativeResultArtifact: reserve,
        assertNativeResultArtifactReserved: assertReserved,
        finalizeNativeResultArtifact: finalize,
      },
      { put },
    );
    const signal = new AbortController().signal;
    const value = { text: 'x'.repeat(256 * 1024) };
    const first = await preparation.prepare({ owner, value, signal });
    expect(first.reference.kind).toBe('artifact');
    expect(bytes?.toString('utf8')).toBe(JSON.stringify(value));
    expect(await preparation.prepare({ owner, value, signal })).toEqual(first);
    expect(reserve).toHaveBeenCalledTimes(3);
    expect(put).toHaveBeenCalledOnce();
    expect(assertReserved).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it('keeps inline preparation available without storage or native reservation ports and refuses larger values', async () => {
    const preparation = createCoordinatorResultValuePreparation({});
    const signal = new AbortController().signal;
    await expect(
      preparation.prepare({ owner, value: { name: 'inline' }, signal }),
    ).resolves.toMatchObject({ reference: { kind: 'inline' } });
    await expect(
      preparation.prepare({
        owner,
        value: { text: 'x'.repeat(256 * 1024) },
        signal,
      }),
    ).rejects.toThrow();
  });
});
