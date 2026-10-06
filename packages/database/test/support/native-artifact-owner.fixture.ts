import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { expect } from 'vitest';
import { WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1 } from '../../src/execution/artifacts/execution-value-representation.js';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
export const owner = {
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
export const metadata = {
  workspaceId: id(1),
  artifactId: id(7),
  byteLength: 300_000,
  sha256: 'b'.repeat(64),
  mediaType: WORKFLOW_EXECUTION_VALUE_MEDIA_TYPE_V1,
  available: false,
} as const;
export type Mode =
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
    if (
      text.includes('prepare_native_attempt_artifact_candidate') ||
      text.includes('prepare_native_result_artifact_candidate')
    ) {
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
    if (
      text.includes('register_native_attempt_artifact_candidate') ||
      text.includes('register_native_result_artifact_candidate')
    ) {
      if (this.mode === 'registration_denied')
        throw new Error('registration denied');
      expect(values[text.includes('register_native_result') ? 4 : 3]).toBe(
        this.artifactId,
      );
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
export function fixture(mode: Mode) {
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
