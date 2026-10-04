import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Pool, type PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import type { ArtifactStore } from '@pertexo/artifact-store';
import {
  createDatabaseRuntime,
  createNodeAttemptRunStore,
  serializeWorkflowExecutionJsonValueV3,
  type NativeNodeAttemptValueSource,
} from '@pertexo/database/execution';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createNodeAttemptValueComposition } from '../src/execution/node-attempt-value-composition.js';
import { hydrateNativeNodeAttemptInputs } from '../src/execution/native-node-attempt-input-hydration.js';
import {
  ValueClient,
  current,
} from './support/node-attempt-artifact-values.fixture.js';

it.each(['inline', 'artifact', 'checksum', 'denied', 'canceled'] as const)(
  'hydrates %s collection serially through actual consumer/codec composition (external pg/storage simulated)',
  async (kind) => {
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
    const store = createNodeAttemptRunStore(config, runtime);
    const controller = new AbortController();
    let uploaded = Buffer.alloc(0);
    const put = vi.fn<ArtifactStore['put']>(async (request) => {
      expect(client.transactionOpen).toBe(false);
      const chunks: Buffer[] = [];
      for await (const chunk of request.body as AsyncIterable<Uint8Array>)
        chunks.push(Buffer.from(chunk));
      uploaded = Buffer.concat(chunks);
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
        throw new Error('Artifact descriptor is missing');
      if (kind === 'canceled') controller.abort();
      return Promise.resolve({
        body: Readable.from([uploaded]),
        metadata: client.descriptor,
      });
    });
    try {
      const values = createNodeAttemptValueComposition(store, {
        put,
        getStream,
      });
      const items = [
        kind === 'inline' ? 'small' : 'x'.repeat(300_000),
        { a: 1 },
      ];
      const snapshot = await values.physicalOutputValues.prepare({
        owner: { kind: 'attempt', slot: 'physical_output', lease: current },
        value: { items, iterationCount: 2 },
        signal: controller.signal,
      });
      const source: Extract<
        NativeNodeAttemptValueSource,
        { slot: 'structured_collection' }
      > = {
        slot: 'structured_collection',
        source: {
          kind: 'physical_output',
          workspaceId: current.workspaceId,
          runId: current.runId,
          workflowVersionId: current.workflowVersionId,
          provenanceId: '99999999-9999-4999-8999-999999999999',
          nodeId: 'inner',
          invocationKey: 'declaration-scope',
          attemptId: current.attemptId,
          collection: {
            loopNodeId: 'inner',
            ordinal: 1,
            collectionSize: 2,
            declaredCollectionChecksum:
              kind === 'checksum'
                ? 'b'.repeat(64)
                : createHash('sha256')
                    .update(serializeWorkflowExecutionJsonValueV3(items))
                    .digest('hex'),
          },
        },
        snapshot: {
          ...snapshot,
          ...(snapshot.reference.kind === 'inline'
            ? {
                serializedValue: serializeWorkflowExecutionJsonValueV3({
                  items,
                  iterationCount: 2,
                }),
              }
            : {}),
        },
      };
      client.nativeSource = source;
      client.denySource = kind === 'denied';
      const result = hydrateNativeNodeAttemptInputs({
        lease: {
          ...current,
          iterationPath: [
            { loopNodeId: 'outer', ordinal: 0 },
            { loopNodeId: 'inner', ordinal: 1 },
          ],
        },
        inputs: {
          abortRequested: false,
          runInput: null,
          completedNodeOutputs: [],
          nativeValueSources: {
            runInput: null,
            completedNodeOutputs: [],
            structuredCollection: source,
          },
        },
        signal: controller.signal,
        hydrate: values.nativeInputValues.hydrateSource,
      });
      if (kind === 'checksum')
        await expect(result).rejects.toMatchObject({
          name: 'NodeAttemptStateCorruptError',
        });
      else if (kind === 'denied')
        await expect(result).rejects.toThrow('current consumer denied');
      else if (kind === 'canceled')
        await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      else
        await expect(result).resolves.toMatchObject({
          structuredCollection: {
            ...source.source.collection,
            collection: items,
          },
        });
      expect(getStream).toHaveBeenCalledTimes(
        kind === 'inline' || kind === 'denied' ? 0 : 1,
      );
      const read = client.statements.findLastIndex((sql) =>
        sql.includes('read_native_attempt_value_source'),
      );
      expect(client.parameters[read]?.[1]).toBe(
        '{"slot":"structured_collection"}',
      );
      expect(
        client.statements.some((sql) =>
          sql.includes('record_native_workflow_attempt_output'),
        ),
      ).toBe(false);
    } finally {
      checkout.mockRestore();
      await store.close();
      await runtime.close();
      uploaded.fill(0);
    }
  },
);
