import { Readable } from 'node:stream';
import { Pool, type PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import type { ArtifactStore } from '@pertexo/artifact-store';
import {
  createDatabaseRuntime,
  createNodeAttemptRunStore,
  type NativeNodeAttemptValueSource,
} from '@pertexo/database/execution';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createNodeAttemptValueComposition } from '../src/execution/node-attempt-value-composition.js';
import {
  ValueClient,
  current,
} from './support/node-attempt-artifact-values.fixture.js';

const value = 'x'.repeat(300_000);
const active = () => new AbortController().signal;
const producer = {
  kind: 'attempt' as const,
  slot: 'call_input' as const,
  lease: current,
};

it.each([
  { slot: 'call_input', stop: 'none' },
  { slot: 'physical_output', stop: 'none' },
  { slot: 'physical_output', stop: 'upload' },
  { slot: 'physical_output', stop: 'cancellation' },
  { slot: 'physical_output', stop: 'completion_denial' },
  { slot: 'physical_output', stop: 'completion_cancellation' },
] as const)(
  'prepares/uploads/reuses/accepts native $slot artifacts with $stop (not SQL qualification)',
  async ({ slot, stop }) => {
    const client = new ValueClient();
    const checkout = vi
      .spyOn(Pool.prototype, 'connect')
      .mockReturnValue(
        Promise.resolve(client as unknown as PoolClient) as never,
      );
    const config = parseDatabaseConfig({
      connectionString:
        'postgresql://pertexo_worker:unused@invalid.invalid/pertexo',
      max: 1,
    });
    const runtime = createDatabaseRuntime(config, { monitorLockWaits: false });
    const runStore = createNodeAttemptRunStore(config, runtime);
    const preparation = new AbortController();
    let uploaded = Buffer.alloc(0);
    const put = vi.fn<ArtifactStore['put']>(async (request) => {
      expect(client.transactionOpen).toBe(false);
      const chunks: Buffer[] = [];
      for await (const chunk of request.body as AsyncIterable<Uint8Array>)
        chunks.push(Buffer.from(chunk));
      uploaded = Buffer.concat(chunks);
      if (put.mock.calls.length === 1 && stop === 'upload')
        throw new Error('object store unavailable');
      if (put.mock.calls.length === 1 && stop === 'cancellation')
        preparation.abort();
      return {
        artifactId: request.artifactId,
        workspaceId: request.workspaceId,
        sha256: request.sha256,
        byteLength: request.byteLength,
        mediaType: request.mediaType,
      };
    });
    const getStream = vi.fn<ArtifactStore['getStream']>(() => {
      expect(client.transactionOpen).toBe(false);
      if (client.descriptor === undefined)
        throw new Error('Available artifact is missing');
      return Promise.resolve({
        body: Readable.from([Buffer.from(uploaded)]),
        metadata: client.descriptor,
      });
    });
    const values = createNodeAttemptValueComposition(runStore, {
      put,
      getStream,
    });
    try {
      const prepare =
        slot === 'call_input'
          ? values.callDeclarationValues.prepare
          : values.physicalOutputValues.prepare;
      if (stop === 'upload' || stop === 'cancellation') {
        const stopped = prepare({
          owner: { ...producer, slot },
          value,
          signal: preparation.signal,
        });
        if (stop === 'upload')
          await expect(stopped).rejects.toThrow('object store unavailable');
        else
          await expect(stopped).rejects.toMatchObject({ name: 'AbortError' });
        expect(
          client.statements.some((text) =>
            text.includes('record_native_workflow_attempt_output'),
          ),
        ).toBe(false);
        expect(client.available).toBe(false);
      }
      const prepared = await prepare({
        owner: { ...producer, slot },
        value,
        signal: active(),
      });
      expect(prepared.reference.kind).toBe('artifact');
      expect(put).toHaveBeenCalledTimes(
        stop === 'upload' || stop === 'cancellation' ? 2 : 1,
      );
      expect(uploaded.toString()).toBe(JSON.stringify(value));
      const reused = await prepare({
        owner: { ...producer, slot },
        value,
        signal: active(),
      });
      expect(reused).toEqual(prepared);
      expect(put).toHaveBeenCalledTimes(
        stop === 'upload' || stop === 'cancellation' ? 2 : 1,
      );
      expect(
        client.statements.filter((text) =>
          text.startsWith('insert into "app"."artifacts"'),
        ),
      ).toHaveLength(1);
      if (slot === 'physical_output') {
        if (
          stop === 'completion_denial' ||
          stop === 'completion_cancellation'
        ) {
          const completion = new AbortController();
          client.denyOutput = stop === 'completion_denial';
          client.abortOutput =
            stop === 'completion_cancellation' ? completion : undefined;
          const stopped = runStore.complete({
            lease: current,
            nativeOutput: prepared,
            outcome: { status: 'succeeded', output: value },
            signal: completion.signal,
          });
          if (stop === 'completion_denial')
            await expect(stopped).rejects.toThrow(
              'physical output owner denied',
            );
          else
            await expect(stopped).rejects.toMatchObject({ name: 'AbortError' });
          expect(
            client.statements.some((text) =>
              text.startsWith('update app.node_attempts'),
            ),
          ).toBe(false);
          expect(
            client.statements.some((text) =>
              text.includes('insert into app.outbox_events'),
            ),
          ).toBe(false);
          if (stop === 'completion_cancellation')
            expect(client.destroyedConnections).toBeGreaterThan(0);
          client.denyOutput = false;
          client.abortOutput = undefined;
        }
        await expect(
          runStore.complete({
            lease: current,
            nativeOutput: prepared,
            outcome: { status: 'succeeded', output: value },
            signal: active(),
          }),
        ).resolves.toMatchObject({ kind: 'committed' });
        const accepted = client.statements.findLastIndex((text) =>
          text.includes('record_native_workflow_attempt_output'),
        );
        expect(accepted).toBeGreaterThan(
          client.statements.findIndex((text) =>
            text.includes('prelock_native_attempt_value_owner'),
          ),
        );
        expect(client.parameters[accepted]?.slice(1)).toEqual([
          JSON.stringify({
            artifactId:
              prepared.reference.kind === 'artifact'
                ? prepared.reference.artifactId
                : '',
            kind: 'artifact',
            schemaVersion: 1,
          }),
          prepared.sha256,
          prepared.byteLength,
          null,
        ]);
        expect(
          client.parameters
            .flat()
            .some(
              (parameter) =>
                typeof parameter === 'string' && parameter.includes(value),
            ),
        ).toBe(false);
        expect(
          client.statements.findIndex((text) =>
            text.startsWith('update app.node_attempts'),
          ),
        ).toBeGreaterThan(accepted);
        expect(put).toHaveBeenCalledTimes(
          stop === 'upload' || stop === 'cancellation' ? 2 : 1,
        );
        return;
      }
      if (
        runStore.recordCallDeclarationInput === undefined ||
        runStore.readCallDeclarationInput === undefined
      )
        throw new Error('Actual input adapters are missing');
      await runStore.recordCallDeclarationInput({
        lease: current,
        ...prepared,
        signal: active(),
      });
      const recovered = await runStore.readCallDeclarationInput({
        lease: { ...current, fenceToken: current.fenceToken + 1 },
        signal: active(),
      });
      expect(recovered).toEqual(prepared);
      await expect(
        values.callDeclarationValues.hydrate({
          owner: { kind: 'attempt', lease: current },
          reference: prepared.reference,
          signal: active(),
        }),
      ).resolves.toBe(value);
      const source: NativeNodeAttemptValueSource = {
        slot: 'run_input',
        source: {
          kind: 'run_input',
          workspaceId: current.workspaceId,
          runId: current.runId,
          workflowVersionId: current.workflowVersionId,
          provenanceId: '99999999-9999-4999-8999-999999999999',
        },
        snapshot: prepared,
      };
      await expect(
        values.nativeInputValues.hydrateSource({
          owner: { kind: 'attempt', lease: current },
          source,
          signal: active(),
        }),
      ).resolves.toBe(value);
      const beforeDeniedRead = getStream.mock.calls.length;
      client.denySource = true;
      await expect(
        values.nativeInputValues.hydrateSource({
          owner: { kind: 'attempt', lease: current },
          source,
          signal: active(),
        }),
      ).rejects.toThrow('current consumer denied');
      expect(getStream).toHaveBeenCalledTimes(beforeDeniedRead);
    } finally {
      checkout.mockRestore();
      await runStore.close();
      await runtime.close();
      uploaded.fill(0);
    }
  },
);
