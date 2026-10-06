import { createHash } from 'node:crypto';
import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ArtifactStore } from '@pertexo/artifact-store';
import { serializeWorkflowExecutionJsonValueV3 } from '@pertexo/database/execution';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCoordinatorValueWorkLifetime,
  COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
  type CoordinatorValueWorkOwner,
} from '../src/execution/coordinator-value-work-lifetime.js';
import { createWorkflowExecutionValueRuntime } from '../src/execution/workflow-execution-value-runtime.js';
import { createWorkflowExecutionResultIdentityV1 } from '../src/execution/workflow-execution-result-identity.js';
import { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 } from '../src/execution/workflow-execution-value-contract.js';

const owner: CoordinatorValueWorkOwner = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  workflowVersionId: '33333333-3333-4333-8333-333333333333',
  delivery: {
    outboxEventId: '44444444-4444-4444-8444-444444444444',
    payloadChecksum: 'a'.repeat(64),
  },
  expectedRevision: 4,
};
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('ordinary literal coordinator preparation with the actual codec/writer', () => {
  it.each([false, true])(
    'prechecks a literal, aborts stalled upload and joins actual spool cleanup without hiding an independent failure (%s)',
    async (cleanupFails) => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'performance'],
      });
      const spoolDirectory = await mkdtemp(
        path.join(tmpdir(), 'pertexo-literal-preparation-'),
      );
      directories.push(spoolDirectory);
      const cleanupFailure = new Error('Independent spool cleanup failure');
      const uploadStarted = Promise.withResolvers<undefined>();
      const uploadCanceled = Promise.withResolvers<undefined>();
      const releaseUploadCleanup = Promise.withResolvers<undefined>();
      const events: string[] = [];
      let uploadBody: Readable | undefined;
      let destination: Writable | undefined;
      const finalize = vi.fn().mockResolvedValue(undefined);
      const authorize = vi.fn();
      const store: Pick<ArtifactStore, 'put' | 'getStream'> = {
        put: async (input) => {
          events.push('put');
          uploadBody = input.body;
          destination = new Writable({
            write() {
              /* Deliberately stalled external upload. */
            },
          });
          uploadStarted.resolve(undefined);
          try {
            await pipeline(input.body, destination, { signal: input.signal });
          } finally {
            uploadCanceled.resolve(undefined);
            await releaseUploadCleanup.promise;
          }
          throw new Error('The stalled upload must not complete');
        },
        getStream: () =>
          Promise.reject(new Error('Preparation must not hydrate')),
      };
      const codec = createWorkflowExecutionValueRuntime({
        store,
        spoolDirectory,
        retentionMillis: 60_000,
        spoolOperations: {
          openFile: (spoolPath) => open(spoolPath, 'wx', 0o600),
          removeDirectory: async (directory) => {
            await rm(directory, { recursive: true, force: true });
            if (cleanupFails) throw cleanupFailure;
          },
        },
        persistence: {
          reserve: (input) => {
            events.push('reserve');
            return Promise.resolve({
              artifactId: '88888888-8888-4888-8888-888888888888',
              workspaceId: owner.workspaceId,
              byteLength: input.byteLength,
              sha256: input.sha256,
              mediaType: input.mediaType,
              available: false,
            });
          },
          assertReserved: () => {
            events.push('assert_reserved');
            return Promise.resolve();
          },
          finalize,
          authorize,
        },
      });
      let checks = 0;
      const lifetime = createCoordinatorValueWorkLifetime({
        policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
        inspectOwner: () => {
          events.push('inspect');
          return Promise.resolve(
            ++checks === 1
              ? {
                  kind: 'active',
                  databaseNow: '2026-10-03T00:00:00.000Z',
                  deadlineAt: null,
                }
              : { kind: 'stopped', stop: { kind: 'canceled' } },
          );
        },
      });
      const value = { text: 'x'.repeat(256 * 1024) };
      const bytes = Buffer.from(serializeWorkflowExecutionJsonValueV3(value));
      // This fixture binds actual admitted bytes; injected persistence is not SQL proof.
      const resultIdentity = createWorkflowExecutionResultIdentityV1({
        ...owner,
        resultRevision: 5,
        resultSelector: { kind: 'literal', value },
        sources: [],
        value: {
          byteLength: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
        },
      });
      const context = new AbortController();
      let finished = false;
      const preparing = lifetime
        .withValueWork(owner, context.signal, (session) =>
          session.perform((signal) =>
            codec.prepare({
              owner: {
                ...owner,
                kind: 'run_result',
                resultRevision: 5,
                resultIdentity,
              },
              value,
              signal,
            }),
          ),
        )
        .then((result) => {
          finished = true;
          return result;
        });
      try {
        // Fail promptly if setup fails before the external upload gate is reached.
        await Promise.race([uploadStarted.promise, preparing]);
        expect(events).toEqual([
          'inspect',
          'reserve',
          'assert_reserved',
          'put',
        ]);
        expect(await readdir(spoolDirectory)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(250);
        await uploadCanceled.promise;
        expect(uploadBody?.destroyed).toBe(true);
        expect(destination?.destroyed).toBe(true);
        expect(finished).toBe(false);
        releaseUploadCleanup.resolve(undefined);
        if (cleanupFails)
          await expect(preparing).rejects.toMatchObject({
            name: 'AggregateError',
            errors: [
              expect.objectContaining({ name: 'AbortError' }),
              cleanupFailure,
            ],
          });
        else
          await expect(preparing).resolves.toEqual({
            kind: 'stopped',
            stop: { kind: 'canceled' },
          });
        expect(uploadBody?.closed).toBe(true);
        expect(await readdir(spoolDirectory)).toEqual([]);
        expect(finalize).not.toHaveBeenCalled();
        expect(authorize).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        releaseUploadCleanup.resolve(undefined);
        context.abort();
        await preparing.catch(() => undefined);
      }
    },
  );
});
