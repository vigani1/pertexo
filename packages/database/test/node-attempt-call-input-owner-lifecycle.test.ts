import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  readWorkflowCallDeclarationInput,
  recordWorkflowCallDeclarationInput,
} from '../src/execution/node-attempts/node-attempt-call-input-record.js';
import type { NodeAttemptLease } from '../src/execution/node-attempts/node-attempt-run-store-contract.js';
import { completeNodeAttempt } from '../src/execution/node-attempts/node-attempt-run-store-completion.js';
import { canonicalOutboxPayloadChecksum } from '../src/execution/transport/outbox.js';

const id = (n: number) =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const lease: NodeAttemptLease = {
  workspaceId: id(1),
  runId: id(2),
  workflowVersionId: id(3),
  nodeRunId: id(4),
  attemptId: id(5),
  attemptNumber: 1,
  admissionKind: 'execute',
  invocationKey: `${id(3)}|call|b:|i:`,
  nodeId: 'call',
  workerId: 'current-worker',
  sideEffectClass: 'unsafe',
  fenceToken: 2,
  leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
  delivery: { outboxEventId: id(6), payloadChecksum: 'b'.repeat(64) },
};
const snapshot = {
  reference: {
    schemaVersion: 1 as const,
    kind: 'inline' as const,
    value: null,
  },
  // Independently known SHA-256 and UTF-8 length of the literal JSON `null`.
  sha256: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
  byteLength: 4,
};

/** External pg boundary only; the actual tenant/Call adapters remain unmocked. */
class AdmissionInterruptedClient extends EventEmitter {
  public readonly statements: string[] = [];
  public readonly releases: (Error | boolean | undefined)[] = [];
  private workspaceId: string | null = null;

  public constructor(private readonly controller: AbortController) {
    super();
  }

  public async query(statement: string, values?: unknown[]) {
    await Promise.resolve();
    this.statements.push(statement);
    if (statement.includes("set_config('app.workspace_id'")) {
      this.workspaceId = values?.[0] as string;
    } else if (statement.includes('current_setting')) {
      return {
        rows: [
          {
            workspace_id: this.workspaceId,
            actor_id: null,
            discovery_scope: null,
          },
        ],
      };
    } else if (statement.includes('lock_workspace_run_admission')) {
      // Delivery of cancellation races with completion of the awaited lock.
      this.controller.abort();
    } else if (statement.includes('read_workflow_call_declaration_input')) {
      return { rows: [{ snapshot: { ...snapshot, serializedValue: 'null' } }] };
    } else if (statement === 'commit' || statement === 'rollback') {
      this.workspaceId = null;
    }
    return { rows: [] };
  }

  public release(destroy?: Error | boolean): void {
    this.releases.push(destroy);
    if (destroy) this.emit('end');
  }
}

describe('Call input owner cancellation through the real tenant adapter', () => {
  it.each(['record', 'read', 'complete'] as const)(
    'does not start protected %s SQL after cancellation during admission',
    async (operation) => {
      const controller = new AbortController();
      const client = new AdmissionInterruptedClient(controller);
      const pool = {
        connect: () => Promise.resolve(client as unknown as PoolClient),
      } as unknown as Pool;
      const result =
        operation === 'record'
          ? recordWorkflowCallDeclarationInput(pool, {
              lease,
              ...snapshot,
              signal: controller.signal,
            })
          : operation === 'read'
            ? readWorkflowCallDeclarationInput(pool, {
                lease,
                signal: controller.signal,
              })
            : completeNodeAttempt(
                pool,
                {
                  lease,
                  outcome: { status: 'succeeded', output: null },
                  signal: controller.signal,
                },
                'workflow_call_input_alias',
              );

      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      const admission = client.statements.findIndex((statement) =>
        statement.includes('lock_workspace_run_admission'),
      );
      expect(admission).toBeGreaterThan(-1);
      expect(client.statements.slice(admission + 1)).toEqual([]);
      // pg PoolClient.release(error) destroys the client just as release(true)
      // does. The ordinary tenant owner supplies its AbortError, not a boolean.
      expect(client.releases).toHaveLength(1);
      expect(client.releases[0]).toBeInstanceOf(Error);
      expect(client.releases[0]).toMatchObject({ name: 'AbortError' });
    },
  );
});

describe('Call completion protected owner ordering (external pg, not SQL proof)', () => {
  it.each(['denial', 'cancellation'] as const)(
    'stops after protected alias %s before receipt/current-run/attempt locks',
    async (stop) => {
      const statements: string[] = [];
      const releases: (Error | boolean | undefined)[] = [];
      const denial = new Error('protected completion denied');
      const controller = new AbortController();
      const payload = {
        schemaVersion: 1,
        workspaceId: lease.workspaceId,
        runId: lease.runId,
        nodeRunId: lease.nodeRunId,
        attemptId: lease.attemptId,
        outboxEventId: lease.delivery.outboxEventId,
      };
      const checksum = canonicalOutboxPayloadChecksum(payload);
      const client = new EventEmitter() as EventEmitter & {
        query: (statement: string, values?: unknown[]) => Promise<unknown>;
        release: (destroy?: Error | boolean) => void;
      };
      let workspaceId: string | null = null;
      client.query = async (statement, values) => {
        await Promise.resolve();
        statements.push(statement);
        if (statement.includes("set_config('app.workspace_id'"))
          workspaceId = values?.[0] as string;
        if (statement.includes('current_setting'))
          return {
            rows: [
              {
                workspace_id: workspaceId,
                actor_id: null,
                discovery_scope: null,
              },
            ],
          };
        if (statement.includes('select aggregate_id'))
          return {
            rows: [
              {
                aggregate_id: lease.attemptId,
                aggregate_type: 'node-attempt',
                job_name: 'execute-node-attempt',
                schema_version: 1,
                payload,
                payload_checksum: checksum,
              },
            ],
          };
        if (
          statement.includes('workflow_call_declaration_completion_reference')
        ) {
          if (stop === 'denial') throw denial;
          controller.abort();
          return {
            rows: [
              { reference: '{"kind":"inline","schemaVersion":1,"value":null}' },
            ],
          };
        }
        if (statement.includes('select completed_at,payload_checksum'))
          return { rows: [{ completed_at: null, payload_checksum: checksum }] };
        if (statement.includes('abort_requested'))
          return {
            rowCount: 1,
            rows: [{ abort_requested: false, native_execution: true }],
          };
        if (statement.includes('select attempt.status'))
          return { rows: [{ attempt_status: 'running' }] };
        if (statement === 'rollback' || statement === 'commit')
          workspaceId = null;
        return { rows: [] };
      };
      client.release = (destroy) => {
        releases.push(destroy);
        if (destroy) client.emit('end');
      };
      const pool = {
        connect: () => Promise.resolve(client as unknown as PoolClient),
      } as unknown as Pool;
      const result = completeNodeAttempt(
        pool,
        {
          lease: {
            ...lease,
            delivery: { ...lease.delivery, payloadChecksum: checksum },
          },
          outcome: { status: 'succeeded', output: null },
          signal: controller.signal,
        },
        'workflow_call_input_alias',
      );
      if (stop === 'denial') await expect(result).rejects.toBe(denial);
      else await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      expect(
        statements.some((statement) =>
          statement.includes('workflow_call_declaration_completion_reference'),
        ),
      ).toBe(true);
      expect(
        statements.some(
          (statement) =>
            statement.includes('select completed_at,payload_checksum') ||
            statement.includes('abort_requested') ||
            statement.includes('select attempt.status') ||
            /insert into|update app/iu.test(statement),
        ),
      ).toBe(false);
      expect(statements).not.toContain('commit');
      if (stop === 'denial') {
        expect(statements).toContain('rollback');
        expect(releases).toEqual([undefined]);
      } else {
        expect(releases).toHaveLength(1);
        expect(releases[0]).toMatchObject({ name: 'AbortError' });
      }
    },
  );
});
