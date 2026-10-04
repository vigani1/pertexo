import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  reserveNativeAttemptArtifact,
  inspectNativeAttemptArtifact,
} from '../src/execution/artifacts/native-attempt-artifact-owner.js';
import { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 } from '../src/execution/artifacts/execution-value-representation.js';
import { NativeArtifactPreparationUnavailableError } from '../src/execution/artifacts/native-attempt-artifact-contract.js';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const owner = {
  kind: 'attempt' as const,
  slot: 'call_input' as const,
  lease: {
    workspaceId: id(1),
    runId: id(2),
    workflowVersionId: id(3),
    nodeRunId: id(4),
    attemptId: id(5),
    attemptNumber: 1,
    admissionKind: 'execute' as const,
    invocationKey: `${id(3)}|call|b:|i:`,
    nodeId: 'call',
    sideEffectClass: 'unsafe' as const,
    workerId: 'worker',
    fenceToken: 2,
    leaseExpiresAt: new Date('2099-01-01T00:00:00Z'),
    delivery: { outboxEventId: id(6), payloadChecksum: 'a'.repeat(64) },
  },
};
const metadata = {
  workspaceId: id(1),
  artifactId: id(7),
  byteLength: 300_000,
  sha256: 'b'.repeat(64),
  mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
  available: false,
} as const;
type Mode =
  | 'fresh'
  | 'reuse'
  | 'available'
  | 'denied'
  | 'unavailable'
  | 'substituted'
  | 'registration_denied'
  | 'abort'
  | 'expired';

/** Only external PostgreSQL is simulated; tenant, Drizzle and artifact owners are real. */
class ArtifactClient extends EventEmitter {
  public readonly statements: { text: string; values: unknown[] }[] = [];
  public readonly releases: (boolean | Error | undefined)[] = [];
  private workspace: string | null = null;
  private artifactId = id(7);
  public constructor(
    private readonly mode: Mode,
    private readonly controller: AbortController,
  ) {
    super();
  }
  public async query(
    command: string | { text: string; rowMode?: string },
    values: unknown[] = [],
  ) {
    await Promise.resolve();
    const text = typeof command === 'string' ? command : command.text;
    this.statements.push({ text, values });
    if (text.includes("set_config('app.workspace_id'"))
      this.workspace = values[0] as string;
    if (text === 'commit' || text === 'rollback') this.workspace = null;
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
    if (text.includes('prepare_native_attempt_artifact_candidate')) {
      if (this.mode === 'denied') throw new Error('actual producer denied');
      if (this.mode === 'abort') this.controller.abort();
      if (this.mode === 'unavailable')
        return {
          rows: [{ result: { kind: 'preparation_unavailable' } }],
          rowCount: 1,
        };
      if (this.mode === 'fresh' || this.mode === 'registration_denied')
        return {
          rows: [
            { result: { kind: 'missing', expiresAt: '2099-01-01T00:00:00Z' } },
          ],
          rowCount: 1,
        };
      return {
        rows: [
          {
            result: {
              kind: 'ready',
              reservation: {
                ...metadata,
                sha256:
                  this.mode === 'substituted'
                    ? 'c'.repeat(64)
                    : metadata.sha256,
                available: this.mode === 'available',
              },
            },
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes('register_native_attempt_artifact_candidate')) {
      if (this.mode === 'registration_denied')
        throw new Error('registration denied');
      expect(values[3]).toBe(this.artifactId);
      return {
        rows: [
          {
            result: {
              kind: 'ready',
              reservation: { ...metadata, artifactId: this.artifactId },
            },
          },
        ],
        rowCount: 1,
      };
    }
    if (text.startsWith('insert into "app"."artifacts"'))
      this.artifactId = values[0] as string;
    if (text.includes(' as expired'))
      return { rows: [{ expired: this.mode === 'expired' }], rowCount: 1 };
    if (text.includes('"app"."artifacts"')) {
      const updated = text.startsWith('update');
      return {
        rows: [
          [
            this.artifactId,
            id(1),
            'execution-value',
            `workspaces/${id(1)}/artifacts/${this.artifactId}`,
            metadata.mediaType,
            metadata.byteLength,
            metadata.sha256,
            updated || this.mode === 'available' ? 'available' : 'pending',
            '2099-01-01T00:00:00Z',
            updated || this.mode === 'available'
              ? '2026-10-04T00:00:00Z'
              : null,
            null,
            null,
            '2026-10-04T00:00:00Z',
            '2026-10-04T00:00:00Z',
          ],
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }
  public release(error?: boolean | Error): void {
    this.releases.push(error);
  }
}
function fixture(mode: Mode) {
  const controller = new AbortController();
  const client = new ArtifactClient(mode, controller);
  const pool = {
    connect: () => Promise.resolve(client as unknown as PoolClient),
  } as unknown as Pool;
  return {
    client,
    pool,
    signal: controller.signal,
    request: {
      owner,
      byteLength: metadata.byteLength,
      sha256: metadata.sha256,
      mediaType: metadata.mediaType,
      signal: controller.signal,
    },
  };
}

describe('native attempt artifact owner (external pg, not SQL authority qualification)', () => {
  it('creates pending metadata and candidate on one current-proven client before committing', async () => {
    const f = fixture('fresh');
    const reserved = await reserveNativeAttemptArtifact(f.pool, f.request);
    expect(reserved).toMatchObject({
      ...metadata,
      artifactId: reserved.artifactId,
    });
    const names = f.client.statements.map(({ text }) => text);
    const proof = names.findIndex((text) =>
      text.includes('prepare_native_attempt_artifact_candidate'),
    );
    const artifact = names.findIndex((text) =>
      text.startsWith('insert into "app"."artifacts"'),
    );
    const candidate = names.findIndex((text) =>
      text.includes('register_native_attempt_artifact_candidate'),
    );
    expect(proof).toBeLessThan(artifact);
    expect(artifact).toBeLessThan(candidate);
    expect(candidate).toBeLessThan(names.indexOf('commit'));
    expect(names.filter((text) => text === 'begin')).toHaveLength(1);
    expect(
      names.some(
        (text) => text.includes('provenance') || text.includes('association'),
      ),
    ).toBe(false);
    expect(f.client.releases).toHaveLength(1);
  });
  it.each(['reuse', 'available'] as const)(
    'reuses %s metadata without inserting or charging again',
    async (mode) => {
      const f = fixture(mode);
      await expect(
        reserveNativeAttemptArtifact(f.pool, f.request),
      ).resolves.toEqual({ ...metadata, available: mode === 'available' });
      expect(
        f.client.statements.some(
          ({ text }) =>
            text.startsWith('insert') || text.includes('register_native'),
        ),
      ).toBe(false);
    },
  );
  it.each(['denied', 'unavailable', 'substituted', 'abort'] as const)(
    'rejects %s before artifact creation',
    async (mode) => {
      const f = fixture(mode);
      const operation = reserveNativeAttemptArtifact(f.pool, f.request);
      if (mode === 'unavailable')
        await expect(operation).rejects.toBeInstanceOf(
          NativeArtifactPreparationUnavailableError,
        );
      else await expect(operation).rejects.toBeInstanceOf(Error);
      expect(
        f.client.statements.some(
          ({ text }) => text.startsWith('insert') || text === 'commit',
        ),
      ).toBe(false);
      expect(f.client.releases).toHaveLength(1);
    },
  );
  it('rolls pending artifact creation back when candidate registration fails', async () => {
    const f = fixture('registration_denied');
    await expect(
      reserveNativeAttemptArtifact(f.pool, f.request),
    ).rejects.toThrow('registration denied');
    expect(
      f.client.statements.some(({ text }) =>
        text.startsWith('insert into "app"."artifacts"'),
      ),
    ).toBe(true);
    expect(f.client.statements.some(({ text }) => text === 'rollback')).toBe(
      true,
    );
    expect(f.client.statements.some(({ text }) => text === 'commit')).toBe(
      false,
    );
  });
  it('reproves the exact reservation then delegates existing finalization, without another insert', async () => {
    const f = fixture('reuse');
    await inspectNativeAttemptArtifact(
      f.pool,
      { owner, reserved: metadata, signal: f.signal },
      true,
    );
    const names = f.client.statements.map(({ text }) => text);
    expect(
      names.findIndex((text) => text.includes('prepare_native')),
    ).toBeLessThan(names.findIndex((text) => text.includes('for update')));
    expect(
      names.some((text) => text.startsWith('update "app"."artifacts"')),
    ).toBe(true);
    expect(names.some((text) => text.startsWith('insert'))).toBe(false);
  });
  it('does not extend or rewrite an already available artifact', async () => {
    const f = fixture('available');
    await inspectNativeAttemptArtifact(
      f.pool,
      { owner, reserved: metadata, signal: f.signal },
      true,
    );
    expect(
      f.client.statements.some(
        ({ text }) => text.startsWith('update') || text.startsWith('insert'),
      ),
    ).toBe(false);
  });
  it('rolls back expired finalization through the existing lifecycle owner', async () => {
    const f = fixture('expired');
    await expect(
      inspectNativeAttemptArtifact(
        f.pool,
        { owner, reserved: metadata, signal: f.signal },
        true,
      ),
    ).rejects.toThrow('Pending artifact has expired');
    expect(
      f.client.statements.some(
        ({ text }) => text === 'commit' || text.startsWith('update'),
      ),
    ).toBe(false);
  });
});
