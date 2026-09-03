import { sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  lockExpectedCompatibilityReleaseSet,
  parseCompatibilityReleaseExpectationSet,
  type CompatibilityReleaseExpectation,
  type CompatibilityReleaseExpectationSet,
} from '../compatibility/compatibility-release.js';
import type { DatabaseConfig } from '../config.js';
import { createWorkspaceDatabase } from '../database.js';
import { acceptWorkflowRun } from '../execution-acceptance.js';
import { consumeInboxMessage } from '../inbox.js';
import { canonicalOutboxPayloadChecksum } from '../outbox.js';
import {
  classifyPublishedWorkflowVersionRow,
  type PublishedWorkflowV2Projection,
} from '../published-workflow-reader.js';

const inputSchema = z
  .object({
    commandId: z.uuid(),
    delivery: z
      .object({
        outboxEventId: z.uuid(),
        payloadChecksum: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict(),
    signal: z.custom<AbortSignal>().optional(),
    workspaceId: z.uuid(),
  })
  .strict();
const payloadSchema = z
  .object({
    commandId: z.uuid(),
    outboxEventId: z.uuid(),
    schemaVersion: z.literal(1),
    workspaceId: z.uuid(),
  })
  .strict();
const requestRowSchema = z
  .object({
    request_fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    run_input: z.json(),
    source_run_id: z.uuid(),
    status: z.enum(['pending', 'completed', 'failed']),
    workflow_id: z.uuid(),
    workflow_version_id: z.uuid(),
  })
  .strict();

export type OperatorRunReplayCheckpointFactory = (
  projection: PublishedWorkflowV2Projection,
  currentCompatibilityRelease: CompatibilityReleaseExpectation,
) => Readonly<{ checkpoint: unknown; engineVersion: string }>;

export class OperatorRunReplayMismatchError extends Error {
  public constructor() {
    super('Run replay delivery does not match its durable request');
    this.name = 'OperatorRunReplayMismatchError';
  }
}

export class OperatorRunReplayNotExecutableError extends Error {
  public constructor() {
    super('Run replay target is not executable by this worker');
    this.name = 'OperatorRunReplayNotExecutableError';
  }
}

export interface OperatorRunReplayStore {
  replay(input: z.input<typeof inputSchema>): Promise<
    Readonly<{
      kind: 'duplicate' | 'processed';
      runId?: string;
    }>
  >;
  fail(
    input: Readonly<{
      commandId: string;
      safeErrorCode: string;
      workspaceId: string;
    }>,
  ): Promise<void>;
  close(): Promise<void>;
}

export function createOperatorRunReplayStore(
  config: DatabaseConfig,
  compatibilityReleaseInput: CompatibilityReleaseExpectationSet,
  checkpointFactory: OperatorRunReplayCheckpointFactory,
): OperatorRunReplayStore {
  const database = createWorkspaceDatabase(config);
  const compatibilityReleases = parseCompatibilityReleaseExpectationSet(
    compatibilityReleaseInput,
  );
  return Object.freeze({
    replay: async (input: z.input<typeof inputSchema>) => {
      const parsed = inputSchema.parse(input);
      parsed.signal?.throwIfAborted();
      const consumed = await consumeInboxMessage(
        database,
        parsed.workspaceId,
        {
          consumerName: 'operator-run-replay',
          messageId: parsed.delivery.outboxEventId,
          payloadChecksum: parsed.delivery.payloadChecksum,
        },
        async (transaction) => {
          const outbox = await transaction.db.execute<{
            aggregate_id: string;
            aggregate_type: string;
            job_name: string;
            payload: unknown;
            payload_checksum: string;
            schema_version: number;
          }>(sql`
            select aggregate_id,aggregate_type,job_name,payload,payload_checksum,schema_version
            from app.outbox_events
            where workspace_id=${transaction.workspaceId}
              and id=${parsed.delivery.outboxEventId}
          `);
          const row = outbox.rows[0];
          const payload = payloadSchema.safeParse(row?.payload);
          if (
            row === undefined ||
            !payload.success ||
            row.aggregate_id !== parsed.commandId ||
            row.aggregate_type !== 'operator-command' ||
            row.job_name !== 'replay-workflow-run' ||
            row.schema_version !== 1 ||
            row.payload_checksum !== parsed.delivery.payloadChecksum ||
            canonicalOutboxPayloadChecksum(payload.data) !==
              row.payload_checksum ||
            payload.data.commandId !== parsed.commandId ||
            payload.data.outboxEventId !== parsed.delivery.outboxEventId ||
            payload.data.workspaceId !== transaction.workspaceId
          )
            throw new OperatorRunReplayMismatchError();

          const requests = await transaction.db.execute(sql`
            select request_fingerprint,run_input,source_run_id,status,
              workflow_id,workflow_version_id
            from app.operator_run_replay_requests
            where workspace_id=${transaction.workspaceId}
              and command_id=${parsed.commandId}
          `);
          const request = requestRowSchema.safeParse(requests.rows[0]);
          if (!request.success || request.data.status !== 'pending')
            throw new OperatorRunReplayMismatchError();

          const currentCompatibilityRelease =
            await lockExpectedCompatibilityReleaseSet(
              transaction.db,
              compatibilityReleases,
            );
          const versions = await transaction.db.execute(
            sql<Record<string, unknown>>`
              select id,workspace_id,workflow_id,version_number,schema_version,
                checksum,executable_schema_version,executable_json,
                compatibility_release_epoch
              from app.workflow_versions
              where workspace_id=${transaction.workspaceId}
                and id=${request.data.workflow_version_id}
            `,
          );
          const classified = classifyPublishedWorkflowVersionRow(
            versions.rows[0],
          );
          if (
            classified.kind !== 'v2_projection' ||
            classified.workflowVersion.workflowId !== request.data.workflow_id
          )
            throw new OperatorRunReplayNotExecutableError();
          const initial = checkpointFactory(
            classified.workflowVersion,
            currentCompatibilityRelease,
          );
          const accepted = await acceptWorkflowRun(transaction, {
            engineVersion: initial.engineVersion,
            initialCheckpoint: initial.checkpoint,
            keyHash: request.data.request_fingerprint,
            operation: 'workflow.run.accept',
            replayCommandId: parsed.commandId,
            replaySourceRunId: request.data.source_run_id,
            requestHash: request.data.request_fingerprint,
            runInput: request.data.run_input,
            scope: `operator:${parsed.commandId}`,
            triggerType: 'replay',
            workflowId: request.data.workflow_id,
            workflowVersionId: request.data.workflow_version_id,
          });
          await transaction.db.execute(sql`
            select app.complete_operator_run_replay(
              ${parsed.commandId}::uuid,
              ${transaction.workspaceId}::uuid,
              ${accepted.runId}::uuid
            )
          `);
          return accepted.runId;
        },
      );
      return consumed.status === 'duplicate'
        ? Object.freeze({ kind: 'duplicate' as const })
        : Object.freeze({ kind: 'processed' as const, runId: consumed.value });
    },
    fail: async (input: Parameters<OperatorRunReplayStore['fail']>[0]) => {
      const parsed = z
        .object({
          commandId: z.uuid(),
          safeErrorCode: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u),
          workspaceId: z.uuid(),
        })
        .strict()
        .parse(input);
      await database.withWorkspace(parsed.workspaceId, async (transaction) => {
        await transaction.db.execute(sql`
          select app.fail_operator_run_replay(
            ${parsed.commandId}::uuid,
            ${transaction.workspaceId}::uuid,
            ${parsed.safeErrorCode}::varchar
          )
        `);
      });
    },
    close: () => database.close(),
  });
}
