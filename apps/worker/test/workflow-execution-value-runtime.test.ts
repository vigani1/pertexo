import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ArtifactStore } from '@pertexo/artifact-store';
import { afterEach, describe, expect, it } from 'vitest';

import { createWorkflowExecutionValueRuntime } from '../src/execution/workflow-execution-value-runtime.js';
import type { WorkflowExecutionValueArtifact } from '../src/execution/workflow-execution-value-codec.js';
import {
  lease,
  WORKSPACE_ID,
  RUN_ID,
  VERSION_ID,
  OUTBOX_EVENT_ID,
} from './support/node-attempt-handler.fixture.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('framework execution value runtime', () => {
  it.each([
    { kind: 'attempt', mode: 'success' },
    { kind: 'run_result', mode: 'success' },
    { kind: 'attempt', mode: 'upload_failure' },
    { kind: 'attempt', mode: 'upload_abort' },
  ] as const)(
    'owns spool cleanup across composed preparation/upload/hydration: $kind/$mode',
    async ({ kind, mode }) => {
      const spoolDirectory = await mkdtemp(
        path.join(tmpdir(), 'pertexo-value-runtime-test-'),
      );
      directories.push(spoolDirectory);
      let reservation: WorkflowExecutionValueArtifact | undefined;
      let uploaded: Buffer | undefined;
      let download: Readable | undefined;
      let uploadBody: Readable | undefined;
      let uploads = 0;
      const controller = new AbortController();
      const uploadFailure = new Error('Object storage is unavailable');
      const store: Pick<ArtifactStore, 'put' | 'getStream'> = {
        put: async (input) => {
          uploads++;
          uploadBody = input.body;
          const chunks: Buffer[] = [];
          for await (const chunk of input.body)
            chunks.push(Buffer.from(chunk as Uint8Array));
          uploaded = Buffer.concat(chunks);
          if (mode === 'upload_failure') throw uploadFailure;
          if (mode === 'upload_abort') controller.abort();
          return {
            artifactId: input.artifactId,
            workspaceId: input.workspaceId,
            byteLength: input.byteLength,
            sha256: input.sha256,
            mediaType: input.mediaType,
          };
        },
        getStream: () => {
          if (uploaded === undefined || reservation === undefined)
            throw new Error('Artifact is not uploaded');
          const { available: _available, ...metadata } = reservation;
          download = Readable.from([Buffer.from(uploaded)]);
          return Promise.resolve({
            body: download,
            metadata,
          });
        },
      };
      const runtime = createWorkflowExecutionValueRuntime({
        store,
        spoolDirectory,
        retentionMillis: 60_000,
        persistence: {
          reserve: (input) => {
            if (reservation !== undefined) return Promise.resolve(reservation);
            reservation = {
              artifactId: '88888888-8888-4888-8888-888888888888',
              workspaceId: WORKSPACE_ID,
              byteLength: input.byteLength,
              sha256: input.sha256,
              mediaType: input.mediaType,
              available: false,
            };
            return Promise.resolve(reservation);
          },
          assertReserved: () => Promise.resolve(),
          finalize: () => {
            if (reservation === undefined)
              throw new Error('Reservation is missing');
            reservation = { ...reservation, available: true };
            return Promise.resolve();
          },
          authorize: () => Promise.resolve(reservation),
        },
      });
      const owner =
        kind === 'attempt'
          ? { kind, lease: lease() }
          : {
              kind,
              workspaceId: WORKSPACE_ID,
              runId: RUN_ID,
              workflowVersionId: VERSION_ID,
              expectedRevision: 4,
              delivery: {
                outboxEventId: OUTBOX_EVENT_ID,
                payloadChecksum: 'a'.repeat(64),
              },
            };
      const signal = controller.signal;
      const value = { text: 'x'.repeat(256 * 1024) };
      const preparing = runtime.prepare({ owner, value, signal });
      if (mode !== 'success') {
        if (mode === 'upload_failure')
          await expect(preparing).rejects.toBe(uploadFailure);
        else
          await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
        expect(reservation?.available).toBe(false);
        expect(uploadBody?.closed).toBe(true);
        expect(await readdir(spoolDirectory)).toEqual([]);
        return;
      }
      const prepared = await preparing;
      expect(prepared.reference.kind).toBe('artifact');
      expect(uploaded?.toString('utf8')).toBe(
        '{"text":"' + 'x'.repeat(256 * 1024) + '"}',
      );
      expect(
        await runtime.hydrate({ owner, reference: prepared.reference, signal }),
      ).toEqual(value);
      expect(download?.destroyed).toBe(true);
      expect(await runtime.prepare({ owner, value, signal })).toEqual(prepared);
      expect(uploads).toBe(1);
      expect(uploadBody?.closed).toBe(true);
      expect(await readdir(spoolDirectory)).toEqual([]);
    },
  );
});
