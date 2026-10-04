import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { Pool, type PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import type { ArtifactStore, ArtifactMetadata } from '@pertexo/artifact-store';
import {
  createDatabaseRuntime,
  createNodeAttemptRunStore,
  type NativeNodeAttemptValueSource,
} from '@pertexo/database/execution';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createNodeAttemptValueComposition } from '../src/execution/node-attempt-value-composition.js';
import { lease } from './support/node-attempt-handler.fixture.js';

const current = lease();
const value = 'x'.repeat(300_000);
const active = () => new AbortController().signal;
const producer = {
  kind: 'attempt' as const,
  slot: 'call_input' as const,
  lease: current,
};

/** Only pg/storage boundaries are simulated; actual tenant/Drizzle/codec/writer/spool compose. */
class ValueClient extends EventEmitter {
  public readonly statements: string[] = [];
  public transactionOpen = false;
  public snapshot: unknown = null;
  public descriptor: ArtifactMetadata | undefined;
  public available = false;
  public denySource = false;
  private workspace: string | null = null;
  private registered = false;
  public async query(
    command: string | { text: string; rowMode?: string },
    values: unknown[] = [],
  ) {
    await Promise.resolve();
    const text = typeof command === 'string' ? command : command.text;
    this.statements.push(text);
    if (text.startsWith('begin')) this.transactionOpen = true;
    if (text.includes("set_config('app.workspace_id'"))
      this.workspace = values[0] as string;
    if (text === 'commit' || text === 'rollback') {
      this.workspace = null;
      this.transactionOpen = false;
    }
    if (text.includes('current_setting'))
      return {
        rows: [
          {
            workspace_id: this.workspace,
            actor_id: null,
            discovery_scope: null,
          },
        ],
        rowCount: 1,
      };
    if (text.includes('prepare_native_attempt_artifact_candidate'))
      return {
        rows: [
          {
            result: this.registered
              ? {
                  kind: 'ready',
                  reservation: {
                    ...this.descriptor,
                    available: this.available,
                  },
                }
              : { kind: 'missing', expiresAt: '2099-01-01T00:00:00Z' },
          },
        ],
        rowCount: 1,
      };
    if (text.includes('register_native_attempt_artifact_candidate')) {
      this.registered = true;
      return {
        rows: [
          {
            result: {
              kind: 'ready',
              reservation: { ...this.descriptor, available: false },
            },
          },
        ],
        rowCount: 1,
      };
    }
    if (text.startsWith('insert into "app"."artifacts"'))
      this.descriptor = {
        artifactId: values[0] as string,
        workspaceId: current.workspaceId,
        mediaType: values[4] as string,
        byteLength: Number(values[5]),
        sha256: values[6] as string,
      };
    if (text.includes(' as expired'))
      return { rows: [{ expired: false }], rowCount: 1 };
    if (text.includes('"app"."artifacts"')) {
      const artifact = this.descriptor;
      if (artifact === undefined)
        throw new Error('Metadata requested before insert');
      if (text.startsWith('update')) this.available = true;
      return {
        rows: [
          [
            artifact.artifactId,
            artifact.workspaceId,
            'execution-value',
            `workspaces/${artifact.workspaceId}/artifacts/${artifact.artifactId}`,
            artifact.mediaType,
            artifact.byteLength,
            artifact.sha256,
            this.available ? 'available' : 'pending',
            '2099-01-01T00:00:00Z',
            this.available ? '2026-10-04T00:00:00Z' : null,
            null,
            null,
            '2026-10-04T00:00:00Z',
            '2026-10-04T00:00:00Z',
          ],
        ],
        rowCount: 1,
      };
    }
    if (text.includes('record_workflow_call_declaration_input')) {
      expect(values[4]).toBeNull();
      this.snapshot = {
        reference: JSON.parse(values[1] as string) as unknown,
        sha256: values[2],
        byteLength: values[3],
      };
    }
    if (text.includes('read_workflow_call_declaration_input'))
      return { rows: [{ snapshot: this.snapshot }], rowCount: 1 };
    if (text.includes('read_native_attempt_value_source')) {
      if (this.denySource) throw new Error('current consumer denied');
      return {
        rows: [
          {
            source: {
              slot: 'run_input',
              source: {
                kind: 'run_input',
                workspaceId: current.workspaceId,
                runId: current.runId,
                workflowVersionId: current.workflowVersionId,
                provenanceId: '99999999-9999-4999-8999-999999999999',
              },
              snapshot: this.snapshot,
            },
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }
  public release(): void {
    /* pool boundary owns no real socket */
  }
}

it('prepares/uploads/reuses/accepts/recovers and hydrates selected native artifact through actual owners (not SQL qualification)', async () => {
  const client = new ValueClient();
  const checkout = vi
    .spyOn(Pool.prototype, 'connect')
    .mockReturnValue(Promise.resolve(client as unknown as PoolClient) as never);
  const config = parseDatabaseConfig({
    connectionString:
      'postgresql://pertexo_worker:unused@invalid.invalid/pertexo',
    max: 1,
  });
  const runtime = createDatabaseRuntime(config, { monitorLockWaits: false });
  const runStore = createNodeAttemptRunStore(config, runtime);
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
    const prepared = await values.callDeclarationValues.prepare({
      owner: producer,
      value,
      signal: active(),
    });
    expect(prepared.reference.kind).toBe('artifact');
    expect(put).toHaveBeenCalledOnce();
    expect(uploaded.toString()).toBe(JSON.stringify(value));
    const reused = await values.callDeclarationValues.prepare({
      owner: producer,
      value,
      signal: active(),
    });
    expect(reused).toEqual(prepared);
    expect(put).toHaveBeenCalledOnce();
    expect(
      client.statements.filter((text) =>
        text.startsWith('insert into "app"."artifacts"'),
      ),
    ).toHaveLength(1);
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
});
