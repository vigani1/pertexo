import type { PoolClient } from 'pg';
import type { PublishedWorkflowV3Projection } from '../published-workflow-reader.js';
import type { CompatibilityReleaseExpectationSet } from '../../compatibility/compatibility-release.js';
import {
  parseWorkspaceId,
  workspaceTransactionFromClient,
} from '../../tenant-access/workspace.js';
import {
  prepareWorkflowCallAdmissionPass,
  sealWorkflowCallAdmissionPass,
} from '../workflow-calls/workflow-call-coordinator-admission.js';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import {
  CoordinatorPlanInvalidError,
  type CoordinatorAdvanceDelivery,
} from './coordinator-run-store-contract.js';

export type CoordinatorCallAdmissionOptions = Readonly<{
  compatibilityReleases: CompatibilityReleaseExpectationSet;
  /** Existing worker interpreter owns its initial checkpoint; DB never imports the engine. */
  createInitialCheckpoint(
    projection: PublishedWorkflowV3Projection,
    engineVersion: string,
  ): unknown;
}>;

/** Prerequisites precede own-run locks; admission remains after CAS/receipt validation. */
export async function prepareCoordinatorCallAdmission(
  client: PoolClient,
  input: Readonly<{
    workspaceId: string;
    runId: string;
    plan: ParsedTransitionPlan;
    delivery: CoordinatorAdvanceDelivery;
    traceparent?: string;
  }>,
  options: CoordinatorCallAdmissionOptions | undefined,
) {
  const declarations = input.plan.workflowCalls?.declarations ?? [];
  if (declarations.length === 0) {
    if (input.plan.checkpoint.schemaVersion === 3) {
      // Even a literal child result must fence ancestors BEFORE canonical
      // own-run/checkpoint locks. This acquires no child admission policy or
      // counter and does not authorize the proposed terminal result.
      await client.query(
        `select app.prelock_native_coordinator_lineage($1::uuid,$2::uuid,$3::text)`,
        [
          input.runId,
          input.delivery.outboxEventId,
          input.delivery.payloadChecksum,
        ],
      );
    }
    return undefined;
  }
  const current = await client.query<{ revision: number }>(
    `select revision from app.run_checkpoints where workspace_id=$1 and workflow_run_id=$2`,
    [input.workspaceId, input.runId],
  );
  if (current.rows[0]?.revision !== input.plan.expectedRevision)
    return undefined;
  if (options === undefined || input.plan.checkpoint.schemaVersion !== 3)
    throw new CoordinatorPlanInvalidError();
  const candidates = [];
  for (const call of declarations) {
    const result = await client.query<PublishedWorkflowV3Projection>(
      `select version.id,version.workspace_id as "workspaceId",version.workflow_id as "workflowId",
              version.version_number as "versionNumber",version.schema_version as "schemaVersion",
              version.executable_schema_version as "executableSchemaVersion",version.executable_json as "executableJson",
              version.checksum,version.compatibility_release_epoch as "compatibilityReleaseEpoch"
         from app.workflow_versions version
         where version.workspace_id=$1 and version.workflow_id=$2 and version.id=$3
           and version.schema_version=2 and version.executable_schema_version=3 and version.checksum=$4`,
      [
        input.workspaceId,
        call.pin.workflowId,
        call.pin.versionId,
        call.pin.checksum,
      ],
    );
    const projection = result.rows[0];
    if (result.rows.length !== 1 || projection === undefined)
      throw new CoordinatorPlanInvalidError();
    candidates.push({
      operation: 'workflow.run.accept' as const,
      triggerType: 'workflow_call' as const,
      workflowId: call.pin.workflowId,
      workflowVersionId: call.pin.versionId,
      engineVersion: input.plan.checkpoint.engineVersion,
      initialCheckpoint: options.createInitialCheckpoint(
        projection,
        input.plan.checkpoint.engineVersion,
      ),
      call: {
        parentRunId: input.runId,
        expectedParentRevision: input.plan.expectedRevision,
        parentDelivery: input.delivery,
        invocationKey: call.invocationKey,
      },
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
    });
  }
  const transaction = workspaceTransactionFromClient(
    client,
    parseWorkspaceId(input.workspaceId),
  );
  const pass = await prepareWorkflowCallAdmissionPass(transaction, {
    parentRunId: input.runId,
    expectedParentRevision: input.plan.expectedRevision,
    parentDelivery: input.delivery,
    compatibilityReleases: options.compatibilityReleases,
    candidates,
  });
  return Object.freeze({
    admit: () => pass.admit(),
    seal: (continuationOutboxEventId: string | undefined) =>
      sealWorkflowCallAdmissionPass(transaction, {
        parentRunId: input.runId,
        expectedParentRevision: input.plan.expectedRevision,
        parentDelivery: input.delivery,
        ...(continuationOutboxEventId === undefined
          ? {}
          : { continuationOutboxEventId }),
      }),
  });
}
