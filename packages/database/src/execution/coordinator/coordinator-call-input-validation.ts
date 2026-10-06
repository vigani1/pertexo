import type { Pool } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { validateCallableValueV1 } from '@pertexo/workflow-model';
import { workflowCallableDeclarationSchemaV1 } from '@pertexo/workflow-model/callable-graph-contract';
import { workflowCallableContractIdentityV1 } from '@pertexo/workflow-model/workflow-call-closure';
import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import { CoordinatorPlanInvalidError } from './coordinator-run-store-contract.js';
import { parseCoordinatorArtifactCallDeclarationRow } from './coordinator-call-declaration-source.js';
import {
  assertCoordinatorNotAborted,
  withCoordinatorReadClient,
} from './coordinator-run-store-transactions.js';
import type {
  NativeCoordinatorCallDeclarationHydrator,
  NativeCoordinatorValueOwner,
} from './coordinator-native-value-read-contract.js';

/** Application-composed validation only: final SQL artifact admission remains refused. */
export async function validateCoordinatorArtifactCallInputs(
  pool: Pool,
  input: Readonly<{
    owner: NativeCoordinatorValueOwner;
    declarations: NonNullable<
      ParsedTransitionPlan['workflowCalls']
    >['declarations'];
    signal: AbortSignal;
    readTimeoutMillis: number;
    hydrate: NativeCoordinatorCallDeclarationHydrator | undefined;
  }>,
): Promise<void> {
  if (input.declarations.length > 64) throw new CoordinatorPlanInvalidError();
  for (const call of input.declarations) {
    if (call.input.kind !== 'artifact') continue;
    assertCoordinatorNotAborted(input.signal);
    const hydrate = input.hydrate;
    if (hydrate === undefined)
      throw new Error('Native Call input precommit hydration is unavailable');
    const material = await withCoordinatorReadClient(
      pool,
      input.owner.workspaceId,
      input.signal,
      async (client) => {
        const rows = await client.query<Record<string, unknown>>(
          `select invocation_key,node_id,attempt_id,callee_version_id,snapshot
         from app.read_workflow_call_declaration_materials($1::uuid,$2::text[],$3::jsonb)`,
          [
            input.owner.runId,
            [call.invocationKey],
            JSON.stringify(input.owner),
          ],
        );
        if (rows.rows.length !== 1) throw new CoordinatorPlanInvalidError();
        const source = parseCoordinatorArtifactCallDeclarationRow(rows.rows[0]);
        if (
          source.invocationKey !== call.invocationKey ||
          source.nodeId !== call.nodeId ||
          source.declarationAttemptId !== call.declarationAttemptId ||
          source.calleeVersionId !== call.pin.versionId ||
          source.snapshot.sha256 !== call.inputChecksum ||
          !isDeepStrictEqual(
            {
              kind: 'artifact',
              artifactId: source.snapshot.reference.artifactId,
            },
            call.input,
          )
        )
          throw new CoordinatorPlanInvalidError();
        const callee = await client.query<{ declaration: unknown }>(
          `select executable_json#>'{graph,callable}' as declaration from app.workflow_versions
         where workspace_id=$1 and workflow_id=$2 and id=$3 and checksum=$4
           and schema_version=2 and executable_schema_version=3`,
          [
            input.owner.workspaceId,
            call.pin.workflowId,
            call.pin.versionId,
            call.pin.checksum,
          ],
        );
        if (callee.rows.length !== 1) throw new CoordinatorPlanInvalidError();
        const declaration = workflowCallableDeclarationSchemaV1.parse(
          callee.rows[0]?.declaration,
        );
        if (
          workflowCallableContractIdentityV1(declaration) !==
          call.pin.callableContractIdentity
        )
          throw new CoordinatorPlanInvalidError();
        return { source, declaration };
      },
      input.readTimeoutMillis,
    );
    assertCoordinatorNotAborted(input.signal);
    // Metadata SQL has released. Each value is decoded, bounded, validated and
    // discarded serially; no decoded artifact payload enters any write owner.
    const value = await hydrate({
      owner: input.owner,
      source: material.source,
      signal: input.signal,
    });
    assertCoordinatorNotAborted(input.signal);
    if (!validateCallableValueV1(material.declaration.input, value).ok)
      throw new CoordinatorPlanInvalidError();
  }
}
