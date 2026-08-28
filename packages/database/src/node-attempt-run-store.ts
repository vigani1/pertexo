import { createDatabasePool } from './postgres-telemetry.js';
import { createHash, randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import type { z } from 'zod';

import type { DatabaseConfig } from './config.js';
import { parsePersistedPhase3Checkpoint } from './phase3-checkpoint.js';
import { canonicalOutboxPayloadChecksum } from './outbox.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
  serializeStoredExecutionValueV1,
} from './stored-execution-value.js';

import {
  DeliveryMismatch,
  NodeAttemptConnectionFenceError,
  NodeAttemptControlActiveError,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptOutputInvalidError,
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
  branchContextSchema,
  claimDeliverySchema,
  completionSchema,
  dispatchSchema,
  heartbeatSchema,
  loadInputsSchema,
  type CompleteNodeAttemptResult,
  type NodeAttemptClaimResult,
  type NodeAttemptCompletion,
  type NodeAttemptDelivery,
  type NodeAttemptInputs,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
} from './node-attempt-run-store-contract.js';
import {
  auditMismatch,
  claimReceipt,
  completeReceipt,
  nodeAttemptConsumerName as consumerName,
  validateDelivery,
} from './node-attempt-run-store-delivery.js';
import {
  assertNotAborted,
  scopedInvocationKey,
  withWorkspaceReadClient,
  withWorkspaceWriteClient,
} from './node-attempt-run-store-transactions.js';

export {
  NodeAttemptConnectionFenceError,
  NodeAttemptControlActiveError,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptOutputInvalidError,
  NodeAttemptReconciliationRequiredError,
  NodeAttemptStateCorruptError,
};
export type {
  CompleteNodeAttemptResult,
  NodeAttemptClaimResult,
  NodeAttemptCompletion,
  NodeAttemptDelivery,
  NodeAttemptInputs,
  NodeAttemptLease,
  NodeAttemptRunStore,
};

async function appendStartedEvent(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    nodeRunId: string;
    attemptId: string;
    invocationKey: string;
    nodeId: string;
    attemptNumber: number;
  }>,
): Promise<void> {
  const sequence = await client.query<{ sequence: number }>(
    `select coalesce(max(sequence),0)::int + 1 as sequence
     from app.run_events where workspace_id=$1 and workflow_run_id=$2`,
    [input.workspaceId, input.runId],
  );
  const next = sequence.rows[0]?.sequence;
  if (next === undefined) throw new NodeAttemptStateCorruptError();
  const payload = serializeStoredExecutionJsonValue({
    schemaVersion: 1,
    nodeRunId: input.nodeRunId,
    attemptId: input.attemptId,
    invocationKey: input.invocationKey,
    nodeId: input.nodeId,
    attemptNumber: input.attemptNumber,
  });
  await client.query(
    `insert into app.run_events (
       workspace_id,workflow_run_id,sequence,type,payload
     ) values ($1,$2,$3,'node.started',$4::jsonb)`,
    [input.workspaceId, input.runId, next, payload],
  );
}

export function createNodeAttemptRunStore(
  config: DatabaseConfig,
): NodeAttemptRunStore {
  const pool = createDatabasePool(config);
  return Object.freeze({
    claimDelivery: async (
      inputValue: Parameters<NodeAttemptRunStore['claimDelivery']>[0],
    ): Promise<NodeAttemptClaimResult> => {
      assertNotAborted(inputValue.signal);
      let input: z.output<typeof claimDeliverySchema>;
      try {
        input = claimDeliverySchema.parse(inputValue);
      } catch {
        throw new NodeAttemptDeliveryMismatchError();
      }
      try {
        return await withWorkspaceWriteClient(
          pool,
          input.workspaceId,
          input.signal,
          async (client) => {
            await validateDelivery(client, input);
            const receipt = await claimReceipt(
              client,
              input.workspaceId,
              input.delivery,
            );
            if (receipt === 'completed')
              return Object.freeze({ kind: 'duplicate' as const });

            const candidate = await client.query<{ run_id: string }>(
              `select node.workflow_run_id as run_id
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
               where attempt.workspace_id=$1 and attempt.id=$2`,
              [input.workspaceId, input.attemptId],
            );
            if (candidate.rows[0]?.run_id !== input.runId)
              throw new NodeAttemptStateCorruptError();
            const run = await client.query<{
              cancel_requested_at: Date | null;
              control_active: boolean;
              deadline_at: Date | null;
              workflow_version_id: string;
            }>(
              `select workflow_version_id,cancel_requested_at,deadline_at,
                      (cancel_requested_at is not null or
                       (deadline_at is not null and
                        deadline_at <= clock_timestamp())) control_active
               from app.workflow_runs
               where workspace_id=$1 and id=$2 for update`,
              [input.workspaceId, input.runId],
            );
            const runRow = run.rows[0];
            if (runRow === undefined) throw new NodeAttemptStateCorruptError();
            const locked = await client.query<{
              admission_kind: 'execute' | 'retry' | 'wait_resume';
              attempt_number: number;
              attempt_status: string;
              dispatch_marked_at: Date | null;
              fence_token: string;
              branch_context: unknown;
              invocation_key: string;
              lease_valid: boolean;
              lease_expires_at: Date | null;
              node_id: string;
              node_status: string;
              provider_idempotency_key: string | null;
              provider_dispatch_binding: string | null;
              provider_dispatch_unresolved: boolean;
              side_effect_class: string;
            }>(
              `select attempt.attempt_number,attempt.admission_kind,
                      attempt.status as attempt_status,
                      attempt.dispatch_marked_at,attempt.fence_token,
                      attempt.lease_expires_at,
                      (attempt.lease_expires_at > clock_timestamp()) lease_valid,
                       node.invocation_key,node.node_id,node.branch_context,
                      node.status as node_status,attempt.side_effect_class,
                       attempt.provider_idempotency_key,
                       node.provider_dispatch_binding,
                       (attempt.dispatch_marked_at is not null or exists (
                         select 1 from app.node_attempts prior
                         where prior.workspace_id=attempt.workspace_id
                           and prior.node_run_id=attempt.node_run_id
                           and prior.attempt_number < attempt.attempt_number
                           and prior.executor_possibly_dispatched is true
                           and prior.retry_decision='retry'
                       )) provider_dispatch_unresolved
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
               where attempt.workspace_id=$1 and attempt.id=$2
                 and attempt.node_run_id=$3 and node.workflow_run_id=$4
                 and node.current_attempt_id=attempt.id
                 and node.current_attempt_number=attempt.attempt_number
               for update of node,attempt`,
              [
                input.workspaceId,
                input.attemptId,
                input.nodeRunId,
                input.runId,
              ],
            );
            const row = locked.rows[0];
            if (row === undefined) throw new NodeAttemptStateCorruptError();
            if (
              [
                'succeeded',
                'failed',
                'canceled',
                'timed_out',
                'outcome_unknown',
              ].includes(row.attempt_status)
            ) {
              await completeReceipt(client, input.workspaceId, input.delivery);
              return Object.freeze({ kind: 'duplicate' as const });
            }
            if (row.attempt_status === 'running') {
              if (row.lease_expires_at !== null && row.lease_valid)
                return Object.freeze({ kind: 'duplicate' as const });
              throw new NodeAttemptReconciliationRequiredError();
            }
            if (row.attempt_status !== 'ready' || row.node_status !== 'ready')
              throw new NodeAttemptStateCorruptError();
            if (runRow.control_active)
              throw new NodeAttemptControlActiveError();
            if (
              row.side_effect_class !== 'safe' &&
              row.side_effect_class !== 'idempotent_with_key' &&
              row.side_effect_class !== 'unsafe'
            )
              throw new NodeAttemptStateCorruptError();
            const branchContext =
              row.branch_context === null
                ? undefined
                : branchContextSchema.safeParse(row.branch_context);
            if (branchContext !== undefined && !branchContext.success)
              throw new NodeAttemptStateCorruptError();

            const claimed = await client.query<{
              fence_token: string;
              lease_expires_at: Date;
            }>(
              `update app.node_attempts
               set status='running',lease_owner=$3,
                   lease_expires_at=clock_timestamp()+make_interval(secs=>$4),
                   fence_token=fence_token+1,
                   started_at=coalesce(started_at,clock_timestamp()),
                   updated_at=clock_timestamp()
               where workspace_id=$1 and id=$2
               returning fence_token,lease_expires_at`,
              [
                input.workspaceId,
                input.attemptId,
                input.workerId,
                input.leaseDurationSeconds,
              ],
            );
            const claim = claimed.rows[0];
            if (claim === undefined) throw new NodeAttemptStateCorruptError();
            await client.query(
              `update app.node_runs
               set status='running',started_at=coalesce(started_at,clock_timestamp()),
                   updated_at=clock_timestamp()
               where workspace_id=$1 and id=$2`,
              [input.workspaceId, input.nodeRunId],
            );
            await appendStartedEvent(client, {
              workspaceId: input.workspaceId,
              runId: input.runId,
              nodeRunId: input.nodeRunId,
              attemptId: input.attemptId,
              invocationKey: row.invocation_key,
              nodeId: row.node_id,
              attemptNumber: row.attempt_number,
            });
            const lease: NodeAttemptLease = Object.freeze({
              workspaceId: input.workspaceId,
              runId: input.runId,
              workflowVersionId: runRow.workflow_version_id,
              nodeRunId: input.nodeRunId,
              attemptId: input.attemptId,
              attemptNumber: row.attempt_number,
              admissionKind: row.admission_kind,
              invocationKey: row.invocation_key,
              nodeId: row.node_id,
              ...(branchContext?.data.branchPath === undefined ||
              branchContext.data.branchPath.length === 0
                ? {}
                : { branchPath: branchContext.data.branchPath }),
              ...(branchContext?.data.iterationPath === undefined ||
              branchContext.data.iterationPath.length === 0
                ? {}
                : { iterationPath: branchContext.data.iterationPath }),
              sideEffectClass: row.side_effect_class,
              ...(row.provider_idempotency_key === null
                ? {}
                : { providerIdempotencyKey: row.provider_idempotency_key }),
              ...(row.provider_dispatch_binding === null
                ? {}
                : { providerDispatchBinding: row.provider_dispatch_binding }),
              ...(row.provider_dispatch_unresolved
                ? { providerDispatchUnresolved: true as const }
                : {}),
              workerId: input.workerId,
              fenceToken: Number(claim.fence_token),
              leaseExpiresAt: new Date(claim.lease_expires_at),
              delivery: Object.freeze(input.delivery),
            });
            if (
              !Number.isSafeInteger(lease.fenceToken) ||
              lease.fenceToken <= 0
            )
              throw new NodeAttemptStateCorruptError();
            return Object.freeze({ kind: 'claimed' as const, lease });
          },
        );
      } catch (error: unknown) {
        if (error instanceof DeliveryMismatch)
          return auditMismatch(
            pool,
            input.workspaceId,
            input.delivery,
            input.signal,
          );
        throw error;
      }
    },
    loadInputs: async (
      inputValue: Parameters<NodeAttemptRunStore['loadInputs']>[0],
    ): Promise<NodeAttemptInputs> => {
      assertNotAborted(inputValue.signal);
      let input: z.output<typeof loadInputsSchema>;
      try {
        input = loadInputsSchema.parse(inputValue);
      } catch {
        throw new NodeAttemptStateCorruptError();
      }
      if (
        input.upstreamNodeOutputs.some(({ nodeId, invocationKey }) => {
          const branchPath = input.lease.branchPath ?? [];
          const nearestBranch = branchPath.at(-1);
          const possibleBranchPaths = [branchPath];
          if (nearestBranch?.nodeId === nodeId)
            possibleBranchPaths.push(branchPath.slice(0, -1));
          return !possibleBranchPaths.some(
            (candidateBranchPath) =>
              invocationKey ===
              scopedInvocationKey({
                workflowVersionId: input.lease.workflowVersionId,
                nodeId,
                branchPath: candidateBranchPath,
                ...(input.lease.iterationPath === undefined
                  ? {}
                  : { iterationPath: input.lease.iterationPath }),
              }),
          );
        })
      )
        throw new NodeAttemptStateCorruptError();
      return withWorkspaceReadClient(
        pool,
        input.lease.workspaceId,
        input.signal,
        async (client) => {
          const current = await client.query<{
            abort_reason: 'canceled' | 'timed_out' | null;
            abort_requested: boolean;
            deadline_at: Date | null;
            input_ref: unknown;
            scheduler_state: unknown;
          }>(
            `select run.input_ref,run.deadline_at,checkpoint.scheduler_state,
                    (run.cancel_requested_at is not null or
                     (run.deadline_at is not null and
                      run.deadline_at <= clock_timestamp())) as abort_requested,
                    case
                      when run.cancel_requested_at is not null then 'canceled'
                      when run.deadline_at is not null and
                           run.deadline_at <= clock_timestamp() then 'timed_out'
                      else null
                    end as abort_reason
             from app.workflow_runs run
             join app.node_runs node
               on node.workspace_id=run.workspace_id
              and node.workflow_run_id=run.id
             join app.node_attempts attempt
               on attempt.workspace_id=node.workspace_id
               and attempt.node_run_id=node.id
             join app.run_checkpoints checkpoint
               on checkpoint.workspace_id=run.workspace_id
              and checkpoint.workflow_run_id=run.id
             where run.workspace_id=$1 and run.id=$2
               and run.workflow_version_id=$3 and node.id=$4
               and node.node_id=$5 and node.invocation_key=$6
               and node.current_attempt_id=$7
               and node.current_attempt_number=$8
               and attempt.id=$7 and attempt.attempt_number=$8
               and attempt.status='running' and attempt.lease_owner=$9
               and attempt.fence_token=$10
               and attempt.lease_expires_at > clock_timestamp()`,
            [
              input.lease.workspaceId,
              input.lease.runId,
              input.lease.workflowVersionId,
              input.lease.nodeRunId,
              input.lease.nodeId,
              input.lease.invocationKey,
              input.lease.attemptId,
              input.lease.attemptNumber,
              input.lease.workerId,
              input.lease.fenceToken,
            ],
          );
          const row = current.rows[0];
          if (row === undefined) throw new NodeAttemptStateCorruptError();
          let runInput: unknown = null;
          if (row.input_ref !== null) {
            const stored = parseStoredExecutionValueV1(row.input_ref);
            if (stored.kind !== 'inline')
              throw new NodeAttemptStateCorruptError();
            runInput = stored.value;
          }
          let resumeOutput: unknown;
          if (input.lease.admissionKind === 'wait_resume') {
            const resumed = await client.query<{ output_ref: unknown }>(
              `select output_ref from app.node_runs
               where workspace_id=$1 and id=$2 and current_attempt_id=$3`,
              [
                input.lease.workspaceId,
                input.lease.nodeRunId,
                input.lease.attemptId,
              ],
            );
            const stored = parseStoredExecutionValueV1(
              resumed.rows[0]?.output_ref,
            );
            if (stored.kind !== 'inline')
              throw new NodeAttemptStateCorruptError();
            resumeOutput = stored.value;
          }

          const completedNodeOutputs: {
            invocationKey: string;
            nodeId: string;
            value: unknown;
          }[] = [];
          if (input.upstreamNodeOutputs.length > 0) {
            const outputs = await client.query<{
              invocation_key: string;
              node_id: string;
              node_output_ref: unknown;
              attempt_output_ref: unknown;
            }>(
              `select node.invocation_key,node.node_id,
                      node.output_ref as node_output_ref,
                      attempt.output_ref as attempt_output_ref
               from app.node_runs node
               join app.node_attempts attempt
                 on attempt.workspace_id=node.workspace_id
                and attempt.id=node.current_attempt_id
                where node.workspace_id=$1 and node.workflow_run_id=$2
                  and node.invocation_key=any($3::varchar[])
                  and node.status='succeeded' and attempt.status='succeeded'
                  and attempt.node_run_id=node.id`,
              [
                input.lease.workspaceId,
                input.lease.runId,
                input.upstreamNodeOutputs.map(
                  ({ invocationKey }) => invocationKey,
                ),
              ],
            );
            if (outputs.rows.length !== input.upstreamNodeOutputs.length)
              throw new NodeAttemptStateCorruptError();
            const outputsByInvocationKey = new Map(
              outputs.rows.map((output) => [output.invocation_key, output]),
            );
            for (const expected of input.upstreamNodeOutputs) {
              const output = outputsByInvocationKey.get(expected.invocationKey);
              if (
                output?.node_id !== expected.nodeId ||
                serializeStoredExecutionJsonValue(output.node_output_ref) !==
                  serializeStoredExecutionJsonValue(output.attempt_output_ref)
              )
                throw new NodeAttemptStateCorruptError();
              const stored = parseStoredExecutionValueV1(
                output.attempt_output_ref,
              );
              if (stored.kind !== 'inline')
                throw new NodeAttemptStateCorruptError();
              completedNodeOutputs.push({
                invocationKey: output.invocation_key,
                nodeId: output.node_id,
                value: stored.value,
              });
            }
          }
          const checkpoint = parsePersistedPhase3Checkpoint(
            row.scheduler_state,
          );
          const join = checkpoint.joins.find(
            ({ joinInvocationKey }) =>
              joinInvocationKey === input.lease.invocationKey,
          );
          const coordinatorInput =
            join?.selectedBranchIds === undefined
              ? undefined
              : {
                  ledger: Object.fromEntries(
                    join.ledger.map(({ branchId, disposition, output }) => [
                      branchId,
                      {
                        disposition,
                        ...(output === undefined ? {} : { output }),
                      },
                    ]),
                  ),
                  selectedBranchIds: join.selectedBranchIds,
                };
          let structuredCollection:
            NonNullable<NodeAttemptInputs['structuredCollection']> | undefined;
          const iterationPath = input.lease.iterationPath ?? [];
          if (iterationPath.length > 0) {
            const branchPath = input.lease.branchPath ?? [];
            const declaredLoops = iterationPath.map((scope, index) => {
              const enclosingIterationPath = iterationPath.slice(0, index);
              const matches = checkpoint.loops.filter(
                (loop) =>
                  loop.loopId === scope.loopNodeId &&
                  serializeStoredExecutionJsonValue(loop.iterationPath) ===
                    serializeStoredExecutionJsonValue(enclosingIterationPath) &&
                  loop.branchPath.length <= branchPath.length &&
                  loop.branchPath.every((part, branchIndex) => {
                    const leasePart = branchPath[branchIndex];
                    return (
                      leasePart?.nodeId === part.nodeId &&
                      leasePart.outputPort === part.outputPort
                    );
                  }) &&
                  loop.activeOrdinals.includes(scope.ordinal),
              );
              if (matches.length !== 1)
                throw new NodeAttemptStateCorruptError();
              return matches[0];
            });
            const nearestScope = iterationPath.at(-1);
            const nearestLoop = declaredLoops.at(-1);
            if (nearestScope === undefined || nearestLoop === undefined)
              throw new NodeAttemptStateCorruptError();
            const declaration = await client.query<{
              attempt_id: string;
              attempt_output_ref: unknown;
              node_output_ref: unknown;
              node_id: string;
            }>(
              `select node.node_id,node.current_attempt_id as attempt_id,
                      node.output_ref as node_output_ref,
                      attempt.output_ref as attempt_output_ref
               from app.node_runs node
               join app.node_attempts attempt
                 on attempt.workspace_id=node.workspace_id
                and attempt.id=node.current_attempt_id
                and attempt.node_run_id=node.id
               where node.workspace_id=$1 and node.workflow_run_id=$2
                 and node.invocation_key=$3
                 and attempt.status='succeeded'`,
              [
                input.lease.workspaceId,
                input.lease.runId,
                nearestLoop.controlInvocationKey,
              ],
            );
            const declarationRow = declaration.rows[0];
            if (
              declaration.rows.length !== 1 ||
              declarationRow?.node_id !== nearestLoop.loopId ||
              nearestLoop.collection.kind !== 'inline' ||
              nearestLoop.collection.attemptId !== declarationRow.attempt_id ||
              serializeStoredExecutionJsonValue(
                declarationRow.node_output_ref,
              ) !==
                serializeStoredExecutionJsonValue(
                  declarationRow.attempt_output_ref,
                )
            )
              throw new NodeAttemptStateCorruptError();
            const stored = parseStoredExecutionValueV1(
              declarationRow.attempt_output_ref,
            );
            if (
              stored.kind !== 'inline' ||
              stored.value === null ||
              Array.isArray(stored.value) ||
              typeof stored.value !== 'object'
            )
              throw new NodeAttemptStateCorruptError();
            const declarationOutput = stored.value as Readonly<
              Record<string, unknown>
            >;
            const keys = Object.keys(declarationOutput).sort();
            const items = declarationOutput.items;
            const iterationCount = declarationOutput.iterationCount;
            const collectionChecksum = Array.isArray(items)
              ? createHash('sha256')
                  .update(serializeStoredExecutionJsonValue(items))
                  .digest('hex')
              : undefined;
            if (
              keys.length !== 2 ||
              keys[0] !== 'items' ||
              keys[1] !== 'iterationCount' ||
              !Array.isArray(items) ||
              typeof iterationCount !== 'number' ||
              !Number.isSafeInteger(iterationCount) ||
              iterationCount !== items.length ||
              nearestLoop.collectionSize !== items.length ||
              nearestScope.ordinal < 0 ||
              nearestScope.ordinal >= items.length ||
              nearestLoop.collectionChecksum !== collectionChecksum
            )
              throw new NodeAttemptStateCorruptError();
            structuredCollection = Object.freeze({
              loopNodeId: nearestLoop.loopId,
              ordinal: nearestScope.ordinal,
              collection: items,
              collectionSize: nearestLoop.collectionSize,
              declaredCollectionChecksum: nearestLoop.collectionChecksum,
            });
          }
          return Object.freeze({
            runInput,
            completedNodeOutputs: Object.freeze(completedNodeOutputs),
            ...(coordinatorInput === undefined ? {} : { coordinatorInput }),
            ...(structuredCollection === undefined
              ? {}
              : { structuredCollection }),
            abortRequested: row.abort_requested,
            ...(row.abort_reason === null
              ? {}
              : { abortReason: row.abort_reason }),
            ...(row.deadline_at === null
              ? {}
              : { deadlineAt: new Date(row.deadline_at) }),
            ...(resumeOutput === undefined ? {} : { resumeOutput }),
          });
        },
      );
    },
    markDispatched: async (
      inputValue: Parameters<NodeAttemptRunStore['markDispatched']>[0],
    ): Promise<Readonly<{ dispatchedAt: Date }>> => {
      assertNotAborted(inputValue.signal);
      let input: z.output<typeof dispatchSchema>;
      try {
        input = dispatchSchema.parse(inputValue);
      } catch {
        throw new NodeAttemptStateCorruptError();
      }
      return withWorkspaceWriteClient(
        pool,
        input.lease.workspaceId,
        input.signal,
        async (client) => {
          if (input.connectionFence !== undefined) {
            const fencedConnection = await client.query<{
              fence_current: boolean;
            }>(
              `select app.connection_dispatch_fence_current(
                 $1,$2,$3,$4,$5
               ) fence_current`,
              [
                input.lease.workspaceId,
                input.connectionFence.connectionId,
                input.connectionFence.expectedProviderKey,
                input.connectionFence.expectedAuthType,
                input.connectionFence.secretVersionId,
              ],
            );
            if (fencedConnection.rows[0]?.fence_current !== true)
              throw new NodeAttemptConnectionFenceError();
          }
          const lockedNode = await client.query<{
            provider_dispatch_binding: string | null;
          }>(
            `select node.provider_dispatch_binding
             from app.node_runs node
             join app.workflow_runs run
               on run.workspace_id=node.workspace_id
              and run.id=node.workflow_run_id
             where node.workspace_id=$1 and node.id=$2
               and node.workflow_run_id=$3 and node.node_id=$4
               and node.invocation_key=$5 and node.current_attempt_id=$6
               and run.workflow_version_id=$7
             for update of node`,
            [
              input.lease.workspaceId,
              input.lease.nodeRunId,
              input.lease.runId,
              input.lease.nodeId,
              input.lease.invocationKey,
              input.lease.attemptId,
              input.lease.workflowVersionId,
            ],
          );
          const existingBinding = lockedNode.rows[0]?.provider_dispatch_binding;
          if (existingBinding === undefined)
            throw new NodeAttemptReconciliationRequiredError();
          if (
            input.providerDispatchBinding !== undefined &&
            existingBinding !== null &&
            existingBinding !== input.providerDispatchBinding
          )
            throw new NodeAttemptDispatchBindingMismatchError();
          if (
            input.providerDispatchBinding !== undefined &&
            existingBinding === null
          )
            await client.query(
              `update app.node_runs
               set provider_dispatch_binding=$3,updated_at=clock_timestamp()
               where workspace_id=$1 and id=$2`,
              [
                input.lease.workspaceId,
                input.lease.nodeRunId,
                input.providerDispatchBinding,
              ],
            );
          const result = await client.query<{ dispatch_marked_at: Date }>(
            `update app.node_attempts attempt
             set dispatch_marked_at=coalesce(dispatch_marked_at,clock_timestamp()),
                 updated_at=clock_timestamp()
             from app.node_runs node,app.workflow_runs run
             where attempt.workspace_id=$1 and attempt.id=$2
               and attempt.node_run_id=$3 and attempt.attempt_number=$4
               and attempt.status='running' and attempt.lease_owner=$5
               and attempt.fence_token=$6
               and attempt.lease_expires_at > clock_timestamp()
               and node.workspace_id=attempt.workspace_id
               and node.id=attempt.node_run_id
               and node.workflow_run_id=$7 and node.node_id=$8
               and node.invocation_key=$9 and node.current_attempt_id=attempt.id
               and run.workspace_id=node.workspace_id and run.id=node.workflow_run_id
               and run.workflow_version_id=$10
             returning attempt.dispatch_marked_at`,
            [
              input.lease.workspaceId,
              input.lease.attemptId,
              input.lease.nodeRunId,
              input.lease.attemptNumber,
              input.lease.workerId,
              input.lease.fenceToken,
              input.lease.runId,
              input.lease.nodeId,
              input.lease.invocationKey,
              input.lease.workflowVersionId,
            ],
          );
          const dispatchedAt = result.rows[0]?.dispatch_marked_at;
          if (dispatchedAt === undefined)
            throw new NodeAttemptReconciliationRequiredError();
          return Object.freeze({ dispatchedAt: new Date(dispatchedAt) });
        },
      );
    },
    heartbeat: async (
      inputValue: Parameters<NodeAttemptRunStore['heartbeat']>[0],
    ): Promise<
      Readonly<{
        leaseExpiresAt: Date;
        abortRequested: boolean;
        abortReason?: 'canceled' | 'timed_out';
      }>
    > => {
      assertNotAborted(inputValue.signal);
      let input: z.output<typeof heartbeatSchema>;
      try {
        input = heartbeatSchema.parse(inputValue);
      } catch {
        throw new NodeAttemptStateCorruptError();
      }
      return withWorkspaceWriteClient(
        pool,
        input.lease.workspaceId,
        input.signal,
        async (client) => {
          const result = await client.query<{
            abort_reason: 'canceled' | 'timed_out' | null;
            abort_requested: boolean;
            lease_expires_at: Date;
          }>(
            `update app.node_attempts attempt
             set lease_expires_at=clock_timestamp()+make_interval(secs=>$7),
                 updated_at=clock_timestamp()
             from app.node_runs node,app.workflow_runs run
             where attempt.workspace_id=$1 and attempt.id=$2
               and attempt.node_run_id=$3 and attempt.attempt_number=$4
               and attempt.status='running' and attempt.lease_owner=$5
               and attempt.fence_token=$6
               and attempt.lease_expires_at > clock_timestamp()
               and node.workspace_id=attempt.workspace_id
               and node.id=attempt.node_run_id and node.workflow_run_id=$8
               and node.node_id=$9 and node.invocation_key=$10
               and node.current_attempt_id=attempt.id
               and run.workspace_id=node.workspace_id and run.id=node.workflow_run_id
               and run.workflow_version_id=$11
             returning attempt.lease_expires_at,
               (run.cancel_requested_at is not null or
                (run.deadline_at is not null and
                 run.deadline_at <= clock_timestamp())) as abort_requested,
               case
                 when run.cancel_requested_at is not null then 'canceled'
                 when run.deadline_at is not null and
                      run.deadline_at <= clock_timestamp() then 'timed_out'
                 else null
               end as abort_reason`,
            [
              input.lease.workspaceId,
              input.lease.attemptId,
              input.lease.nodeRunId,
              input.lease.attemptNumber,
              input.lease.workerId,
              input.lease.fenceToken,
              input.leaseDurationSeconds,
              input.lease.runId,
              input.lease.nodeId,
              input.lease.invocationKey,
              input.lease.workflowVersionId,
            ],
          );
          const row = result.rows[0];
          if (row === undefined)
            throw new NodeAttemptReconciliationRequiredError();
          return Object.freeze({
            leaseExpiresAt: new Date(row.lease_expires_at),
            abortRequested: row.abort_requested,
            ...(row.abort_reason === null
              ? {}
              : { abortReason: row.abort_reason }),
          });
        },
      );
    },
    complete: async (
      inputValue: Parameters<NodeAttemptRunStore['complete']>[0],
    ): Promise<CompleteNodeAttemptResult> => {
      assertNotAborted(inputValue.signal);
      let input: z.output<typeof completionSchema>;
      try {
        input = completionSchema.parse(inputValue);
      } catch {
        throw new NodeAttemptStateCorruptError();
      }
      let serializedOutput: string | null = null;
      if (
        input.outcome.status === 'succeeded' ||
        input.outcome.status === 'suspended'
      ) {
        try {
          serializedOutput = serializeStoredExecutionValueV1({
            schemaVersion: 1,
            kind: 'inline',
            value: input.outcome.output,
          });
        } catch {
          throw new NodeAttemptOutputInvalidError();
        }
      }
      try {
        return await withWorkspaceWriteClient(
          pool,
          input.lease.workspaceId,
          input.signal,
          async (client) => {
            await validateDelivery(client, {
              workspaceId: input.lease.workspaceId,
              runId: input.lease.runId,
              nodeRunId: input.lease.nodeRunId,
              attemptId: input.lease.attemptId,
              delivery: input.lease.delivery,
              leaseDurationSeconds: 1,
              workerId: input.lease.workerId,
              signal: input.signal,
            });
            const receipt = await client.query<{
              completed_at: Date | null;
              payload_checksum: string;
            }>(
              `select completed_at,payload_checksum
               from app.inbox_receipts
               where consumer_name=$1 and message_id=$2 and workspace_id=$3
               for update`,
              [
                consumerName,
                input.lease.delivery.outboxEventId,
                input.lease.workspaceId,
              ],
            );
            const receiptRow = receipt.rows[0];
            if (
              receiptRow?.payload_checksum !==
              input.lease.delivery.payloadChecksum
            )
              throw new NodeAttemptStateCorruptError();

            const run = await client.query<{
              abort_requested: boolean;
            }>(
              `select (
                 cancel_requested_at is not null or
                 (deadline_at is not null and deadline_at <= clock_timestamp())
               ) abort_requested
               from app.workflow_runs
               where workspace_id=$1 and id=$2 and workflow_version_id=$3
               for update`,
              [
                input.lease.workspaceId,
                input.lease.runId,
                input.lease.workflowVersionId,
              ],
            );
            if (run.rowCount !== 1) throw new NodeAttemptStateCorruptError();
            if (
              input.outcome.status === 'suspended' &&
              run.rows[0]?.abort_requested
            )
              throw new NodeAttemptReconciliationRequiredError();
            const locked = await client.query<{
              attempt_status: string;
              error_summary: string | null;
              executor_error_kind: string | null;
              executor_failure_kind: string | null;
              executor_possibly_dispatched: boolean | null;
              fence_token: string;
              lease_valid: boolean;
              lease_expires_at: Date | null;
              lease_owner: string | null;
              node_status: string;
              output_ref: unknown;
              safe_error_code: string | null;
              retry_decision: string | null;
              wait_kind: string | null;
            }>(
              `select attempt.status attempt_status,attempt.fence_token,
                      attempt.lease_owner,attempt.lease_expires_at,
                      (attempt.lease_expires_at > clock_timestamp()) lease_valid,
                      attempt.output_ref,attempt.safe_error_code,
                       attempt.error_summary,attempt.executor_failure_kind,
                       attempt.executor_error_kind,
                       attempt.executor_possibly_dispatched,
                        attempt.retry_decision,node.status node_status,node.wait_kind
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id
                and node.id=attempt.node_run_id
               where attempt.workspace_id=$1 and attempt.id=$2
                 and attempt.node_run_id=$3 and attempt.attempt_number=$4
                 and node.workflow_run_id=$5 and node.node_id=$6
                 and node.invocation_key=$7
                 and node.current_attempt_id=attempt.id
               for update of node,attempt`,
              [
                input.lease.workspaceId,
                input.lease.attemptId,
                input.lease.nodeRunId,
                input.lease.attemptNumber,
                input.lease.runId,
                input.lease.nodeId,
                input.lease.invocationKey,
              ],
            );
            const row = locked.rows[0];
            if (row === undefined) throw new NodeAttemptStateCorruptError();
            const executorOutcome =
              input.outcome.status === 'executor_failure'
                ? input.outcome
                : undefined;
            const durableStatus =
              executorOutcome !== undefined
                ? 'failed'
                : input.outcome.status === 'suspended'
                  ? 'succeeded'
                  : input.outcome.status;
            const safeErrorCode =
              input.outcome.status === 'succeeded' ||
              input.outcome.status === 'suspended'
                ? null
                : input.outcome.safeErrorCode;
            const errorSummary =
              input.outcome.status === 'succeeded' ||
              input.outcome.status === 'suspended' ||
              input.outcome.status === 'executor_failure'
                ? null
                : (input.outcome.errorSummary ?? null);
            if (
              [
                'succeeded',
                'failed',
                'canceled',
                'timed_out',
                'outcome_unknown',
              ].includes(row.attempt_status)
            ) {
              const persistedOutput =
                row.output_ref === null
                  ? null
                  : serializeStoredExecutionValueV1(row.output_ref);
              if (
                row.attempt_status !== durableStatus ||
                (executorOutcome === undefined &&
                  input.outcome.status !== 'suspended' &&
                  row.node_status !== durableStatus) ||
                (input.outcome.status === 'suspended' &&
                  (row.node_status !== 'waiting' ||
                    row.wait_kind !== 'node_wait')) ||
                persistedOutput !== serializedOutput ||
                row.safe_error_code !== safeErrorCode ||
                row.error_summary !== errorSummary ||
                (executorOutcome !== undefined &&
                  (row.executor_failure_kind !== executorOutcome.failureKind ||
                    row.executor_error_kind !== executorOutcome.errorKind ||
                    row.executor_possibly_dispatched !==
                      executorOutcome.possiblyDispatched ||
                    row.retry_decision === null))
              )
                throw new NodeAttemptStateCorruptError();
              if (receiptRow.completed_at === null)
                await completeReceipt(
                  client,
                  input.lease.workspaceId,
                  input.lease.delivery,
                );
              return Object.freeze({
                kind: 'duplicate' as const,
                outboxEventId: null,
              });
            }
            if (
              row.attempt_status !== 'running' ||
              row.node_status !== 'running' ||
              row.lease_owner !== input.lease.workerId ||
              Number(row.fence_token) !== input.lease.fenceToken ||
              row.lease_expires_at === null ||
              !row.lease_valid ||
              receiptRow.completed_at !== null
            )
              throw new NodeAttemptReconciliationRequiredError();

            await client.query(
              `update app.node_attempts
                set status=$3,lease_owner=null,lease_expires_at=null,
                    output_ref=$4::jsonb,safe_error_code=$5,error_summary=$6,
                    executor_failure_kind=$7,executor_error_kind=$8,
                    executor_possibly_dispatched=$9,retry_decision=$10,
                    completed_at=clock_timestamp(),updated_at=clock_timestamp()
                where workspace_id=$1 and id=$2`,
              [
                input.lease.workspaceId,
                input.lease.attemptId,
                durableStatus,
                serializedOutput,
                safeErrorCode,
                errorSummary,
                executorOutcome?.failureKind ?? null,
                executorOutcome?.errorKind ?? null,
                executorOutcome?.possiblyDispatched ?? null,
                executorOutcome === undefined ? null : 'pending',
              ],
            );
            if (executorOutcome !== undefined) {
              const outboxEventId = randomUUID();
              const payload = {
                schemaVersion: 1,
                workspaceId: input.lease.workspaceId,
                runId: input.lease.runId,
                outboxEventId,
                ...(input.traceparent === undefined
                  ? {}
                  : { traceparent: input.traceparent }),
              } as const;
              await client.query(
                `insert into app.outbox_events (
                   id,workspace_id,job_name,schema_version,aggregate_type,
                   aggregate_id,payload,payload_checksum
                 ) values ($1,$2,'advance-workflow-run',1,'workflow-run',$3,$4::jsonb,$5)`,
                [
                  outboxEventId,
                  input.lease.workspaceId,
                  input.lease.runId,
                  serializeStoredExecutionJsonValue(payload),
                  canonicalOutboxPayloadChecksum(payload),
                ],
              );
              await completeReceipt(
                client,
                input.lease.workspaceId,
                input.lease.delivery,
              );
              return Object.freeze({
                kind: 'committed' as const,
                outboxEventId,
              });
            }
            if (input.outcome.status === 'suspended') {
              const suspended = await client.query<{ resume_at: Date }>(
                `update app.node_runs
                 set status='waiting',output_ref=$3::jsonb,wait_kind='node_wait',
                     resume_at=clock_timestamp()+make_interval(secs=>$4),
                     retry_due_at=null,due_wakeup_at=null,safe_error_code=null,
                     completed_at=null,updated_at=clock_timestamp()
                 where workspace_id=$1 and id=$2 and current_attempt_id=$5
                   and status='running'
                 returning resume_at`,
                [
                  input.lease.workspaceId,
                  input.lease.nodeRunId,
                  serializedOutput,
                  input.outcome.durationSeconds,
                  input.lease.attemptId,
                ],
              );
              const resumeAt = suspended.rows[0]?.resume_at;
              if (resumeAt === undefined)
                throw new NodeAttemptStateCorruptError();
              const sequenceResult = await client.query<{ sequence: number }>(
                `select coalesce(max(sequence),0)::int+1 sequence
                 from app.run_events where workspace_id=$1 and workflow_run_id=$2`,
                [input.lease.workspaceId, input.lease.runId],
              );
              const sequence = sequenceResult.rows[0]?.sequence;
              if (sequence === undefined)
                throw new NodeAttemptStateCorruptError();
              await client.query(
                `insert into app.run_events (
                   workspace_id,workflow_run_id,sequence,type,payload
                 ) values ($1,$2,$3,'node.waiting',$4::jsonb)`,
                [
                  input.lease.workspaceId,
                  input.lease.runId,
                  sequence,
                  serializeStoredExecutionJsonValue({
                    schemaVersion: 1,
                    nodeRunId: input.lease.nodeRunId,
                    attemptId: input.lease.attemptId,
                    invocationKey: input.lease.invocationKey,
                    nodeId: input.lease.nodeId,
                    attemptNumber: input.lease.attemptNumber,
                    dueAt: new Date(resumeAt).toISOString(),
                    waitKind: 'node_wait',
                  }),
                ],
              );
              const outboxEventId = randomUUID();
              const payload = {
                schemaVersion: 1,
                workspaceId: input.lease.workspaceId,
                runId: input.lease.runId,
                outboxEventId,
                ...(input.traceparent === undefined
                  ? {}
                  : { traceparent: input.traceparent }),
              } as const;
              await client.query(
                `insert into app.outbox_events (
                   id,workspace_id,job_name,schema_version,aggregate_type,
                   aggregate_id,payload,payload_checksum
                 ) values ($1,$2,'advance-workflow-run',1,'workflow-run',$3,$4::jsonb,$5)`,
                [
                  outboxEventId,
                  input.lease.workspaceId,
                  input.lease.runId,
                  serializeStoredExecutionJsonValue(payload),
                  canonicalOutboxPayloadChecksum(payload),
                ],
              );
              await completeReceipt(
                client,
                input.lease.workspaceId,
                input.lease.delivery,
              );
              return Object.freeze({
                kind: 'committed' as const,
                outboxEventId,
              });
            }
            const node = await client.query(
              `update app.node_runs
               set status=$3,output_ref=$4::jsonb,safe_error_code=$5,
                   completed_at=clock_timestamp(),updated_at=clock_timestamp()
               where workspace_id=$1 and id=$2 and current_attempt_id=$6`,
              [
                input.lease.workspaceId,
                input.lease.nodeRunId,
                durableStatus,
                serializedOutput,
                safeErrorCode,
                input.lease.attemptId,
              ],
            );
            if (node.rowCount !== 1) throw new NodeAttemptStateCorruptError();

            const eventSequence = await client.query<{ sequence: number }>(
              `select coalesce(max(sequence),0)::int+1 sequence
               from app.run_events where workspace_id=$1 and workflow_run_id=$2`,
              [input.lease.workspaceId, input.lease.runId],
            );
            const sequence = eventSequence.rows[0]?.sequence;
            if (sequence === undefined)
              throw new NodeAttemptStateCorruptError();
            const eventPayload = serializeStoredExecutionJsonValue({
              schemaVersion: 1,
              nodeRunId: input.lease.nodeRunId,
              attemptId: input.lease.attemptId,
              invocationKey: input.lease.invocationKey,
              nodeId: input.lease.nodeId,
              attemptNumber: input.lease.attemptNumber,
              ...(safeErrorCode === null ? {} : { safeErrorCode }),
            });
            await client.query(
              `insert into app.run_events (
                 workspace_id,workflow_run_id,sequence,type,payload
               ) values ($1,$2,$3,$4,$5::jsonb)`,
              [
                input.lease.workspaceId,
                input.lease.runId,
                sequence,
                `node.${input.outcome.status}`,
                eventPayload,
              ],
            );

            const outboxEventId = randomUUID();
            const payload = {
              schemaVersion: 1,
              workspaceId: input.lease.workspaceId,
              runId: input.lease.runId,
              outboxEventId,
              ...(input.traceparent === undefined
                ? {}
                : { traceparent: input.traceparent }),
            } as const;
            await client.query(
              `insert into app.outbox_events (
                 id,workspace_id,job_name,schema_version,aggregate_type,
                 aggregate_id,payload,payload_checksum
               ) values ($1,$2,'advance-workflow-run',1,'workflow-run',$3,$4::jsonb,$5)`,
              [
                outboxEventId,
                input.lease.workspaceId,
                input.lease.runId,
                serializeStoredExecutionJsonValue(payload),
                canonicalOutboxPayloadChecksum(payload),
              ],
            );
            await completeReceipt(
              client,
              input.lease.workspaceId,
              input.lease.delivery,
            );
            return Object.freeze({
              kind: 'committed' as const,
              outboxEventId,
            });
          },
        );
      } catch (error: unknown) {
        if (error instanceof DeliveryMismatch)
          return auditMismatch(
            pool,
            input.lease.workspaceId,
            input.lease.delivery,
            input.signal,
          );
        throw error;
      }
    },
    close: async (): Promise<void> => pool.end(),
  });
}
