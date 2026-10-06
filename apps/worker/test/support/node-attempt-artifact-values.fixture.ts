import { EventEmitter } from 'node:events';
import { expect } from 'vitest';
import type { ArtifactMetadata } from '@pertexo/artifact-store';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/execution';
import { lease, delivery } from './node-attempt-handler.fixture.js';

export const payload = delivery().data;
export const current = {
  ...lease(),
  delivery: {
    ...lease().delivery,
    payloadChecksum: canonicalOutboxPayloadChecksum(payload),
  },
};
/** Only pg/storage boundaries are simulated; actual tenant/Drizzle/codec/writer/spool compose. */
export class ValueClient extends EventEmitter {
  public readonly statements: string[] = [];
  public readonly parameters: unknown[][] = [];
  public transactionOpen = false;
  public snapshot: unknown = null;
  public nativeSource: unknown;
  public logicalNodeStatus:
    | 'waiting'
    | 'failed'
    | 'canceled'
    | 'timed_out'
    | 'outcome_unknown'
    | undefined;
  public descriptor: ArtifactMetadata | undefined;
  public available = false;
  public denySource = false;
  public denyOutput = false;
  public abortOutput: AbortController | undefined;
  public destroyedConnections = 0;
  private physicalOutput:
    { reference: unknown; sha256: unknown; byteLength: unknown } | undefined;
  private completed = false;
  private workspace: string | null = null;
  private registered = false;
  public async query(
    command: string | { text: string; rowMode?: string },
    values: unknown[] = [],
  ) {
    await Promise.resolve();
    const text = typeof command === 'string' ? command : command.text;
    this.statements.push(text);
    this.parameters.push(values);
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
    if (text.includes('record_native_workflow_attempt_output')) {
      if (this.denyOutput) throw new Error('physical output owner denied');
      this.abortOutput?.abort();
      if (!this.abortOutput?.signal.aborted)
        this.physicalOutput = {
          reference: JSON.parse(values[1] as string) as unknown,
          sha256: values[2],
          byteLength: values[3],
        };
    }
    if (text.includes('native_attempt_artifact_output_replay_matches'))
      return {
        rows: [
          {
            matches:
              this.completed &&
              JSON.stringify(JSON.parse(values[1] as string)) ===
                JSON.stringify(this.physicalOutput?.reference) &&
              values[2] === this.physicalOutput?.sha256 &&
              values[3] === this.physicalOutput?.byteLength,
          },
        ],
        rowCount: 1,
      };
    if (text.startsWith('update app.node_attempts')) this.completed = true;
    if (text.includes('read_native_attempt_value_source')) {
      if (this.denySource) throw new Error('current consumer denied');
      return {
        rows: [
          {
            source: this.nativeSource ?? {
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
    if (text.includes('select aggregate_id'))
      return {
        rows: [
          {
            aggregate_id: current.attemptId,
            aggregate_type: 'node-attempt',
            job_name: 'execute-node-attempt',
            schema_version: 1,
            payload,
            payload_checksum: current.delivery.payloadChecksum,
          },
        ],
        rowCount: 1,
      };
    if (text.includes('physical_completion_recorded'))
      return {
        rows: [
          {
            native_execution: true,
            physical_completion_recorded: this.completed,
          },
        ],
        rowCount: 1,
      };
    if (text.includes('select completed_at,payload_checksum'))
      return {
        rows: [
          {
            completed_at: this.completed ? new Date('2026-10-04') : null,
            payload_checksum: current.delivery.payloadChecksum,
          },
        ],
        rowCount: 1,
      };
    if (text.includes(') abort_requested'))
      return {
        rows: [{ abort_requested: false, native_execution: true }],
        rowCount: 1,
      };
    if (text.includes('attempt.status attempt_status'))
      return {
        rows: [
          {
            attempt_status: this.completed ? 'succeeded' : 'running',
            node_status: this.completed
              ? (this.logicalNodeStatus ?? 'succeeded')
              : 'running',
            current_attempt: true,
            fence_token: current.fenceToken,
            lease_owner: this.completed ? null : current.workerId,
            lease_expires_at: this.completed ? null : current.leaseExpiresAt,
            lease_valid: !this.completed,
            output_ref: this.completed ? this.physicalOutput?.reference : null,
            safe_error_code: null,
            error_summary: null,
            executor_failure_kind: null,
            executor_error_kind: null,
            executor_possibly_dispatched: null,
            retry_decision: null,
            wait_kind: null,
            suspension_recorded: false,
          },
        ],
        rowCount: 1,
      };
    if (text.includes('coalesce(max(sequence)'))
      return { rows: [{ sequence: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }
  public release(error?: boolean | Error): void {
    if (error) {
      // The external pool stub reconnects to the same simulated database state;
      // destroyed connection-local tenant state must not survive the next checkout.
      this.destroyedConnections += 1;
      this.workspace = null;
      this.transactionOpen = false;
      this.emit('end');
    }
  }
}
