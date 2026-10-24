import { requireConnectionBindings } from '../../tenant-access/resources/connections/bindings.js';
import { requireWorkflowCallTargets } from '../../tenant-access/resources/bindings.js';
import { lockArtifactReferences } from '../../artifacts/references/repository.js';
import { createHash } from 'node:crypto';

import {
  canonicalWorkflowPortableJson,
  portableGraphDigest,
  portableManifestDigest,
  projectWorkflowPortableManifest,
  WORKFLOW_PORTABILITY_LIMITS,
} from '@pertexo/workflow-model';
import { workflowDefinitionCatalogFingerprint } from '@pertexo/workflow-model/server';
import {claimCommand, completeCommand, credentialCommandScope} from '../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import type {
  ExportWorkflowInput,
  ImportWorkflowInput,
  PreviewWorkflowImportInput,
  WorkflowAuthoringDatabase,
} from '../workflows/contracts.js';
import type { WorkflowAuthoringWriteContext } from '../workflows/context.js';

import {
  WorkflowNotFoundError,
  WorkflowPortabilityCompatibilityConflictError,
  WorkflowPortabilityReviewConflictError,
  WorkflowPortabilityValidationError,
} from '../workflows/errors.js';
import { admitWorkflowAuthoring } from '../workflows/admission.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { lockPortableSource, reviewedSourceGraph } from './source-authority.js';

import {
  previewInput,
  importInput,
  importResultSchema,
  exportInput,
} from './contract.js';
import { selectedPolicy, inspectImport, portableFailure } from './admission.js';

async function requirePortabilityAuthority(
  client: Parameters<typeof lockWorkflowAuthoringAuthority>[0],
  input: Readonly<{ workspaceId: string; actorId: string }>,
  { write }: Readonly<{ write: boolean }>,
): Promise<void> {
  await lockWorkflowAuthoringAuthority(client, input.workspaceId, {
    actorId: input.actorId,
    roles: rolesForCapability(write ? 'workflow:create' : 'workflow:read'),
  });
}

/** The import command's digest, which a template origin records. */
export function workflowImportCommandDigest(
  input: Omit<ImportWorkflowInput, 'templateIssues'>,
): string {
  const command = canonicalWorkflowPortableJson({
    manifest: input.manifest,
    bindings: input.bindings,
    name: input.name,
    expectedCompatibilityFingerprint: input.expectedCompatibilityFingerprint,
    ...(input.templateOrigin === undefined
      ? {}
      : { templateOrigin: input.templateOrigin }),
  });
  return createHash('sha256').update(command).digest('hex');
}

function exportPortableWorkflow(
  context: WorkflowAuthoringWriteContext,
  rawInput: ExportWorkflowInput,
) {
  exportInput.parse(rawInput);
  const input: ExportWorkflowInput = rawInput;
  return context.transact(
    input.workspaceId,
    input.actorId,
    async (client) => {
      await requirePortabilityAuthority(client, input, { write: false });
      const row = await lockPortableSource(client, input);
      const selection = context.catalogs;
      const graph = reviewedSourceGraph(input, row, selection);
      if ((await portableGraphDigest(graph)) !== input.reviewedGraphDigest)
        throw new WorkflowPortabilityReviewConflictError(
          'Reviewed workflow source changed',
        );
      try {
        const manifest = projectWorkflowPortableManifest(
          graph,
          selectedPolicy(selection),
        );
        const admission = await admitWorkflowAuthoring(
          client,
          selection.validateAuthoringGraph,
          graph,
          input.signal === undefined ? {} : { signal: input.signal },
        );
        if (
          admission.issues.some(({ code }) =>
            [
              'invalid_expression',
              'invalid_mapping',
              'dangling_edge',
              'duplicate_node_id',
              'duplicate_edge_id',
              'invalid_graph',
              'invalid_structured_body',
              'graph_limit',
            ].includes(code),
          )
        )
          throw new WorkflowPortabilityValidationError(
            admission.issues
              .slice(0, WORKFLOW_PORTABILITY_LIMITS.issues)
              .map(({ code, path }) => ({
                code,
                path: path.slice(0, 2048),
                message:
                  'The graph is not valid under the serving authoring policy.',
              })),
            {
              truncated:
                admission.issues.length > WORKFLOW_PORTABILITY_LIMITS.issues,
            },
          );
        return manifest;
      } catch (error) {
        portableFailure(error);
      }
    },
    input.signal,
  );
}

function previewPortableWorkflow(
  context: WorkflowAuthoringWriteContext,
  rawInput: PreviewWorkflowImportInput,
) {
  canonicalWorkflowPortableJson({
    manifest: rawInput.manifest,
    bindings: rawInput.bindings,
  });
  const {
    templateIssues: _verification,
    templateOrigin: _origin,
    ...unverified
  } = rawInput;
  const parsed = previewInput.parse(unverified);
  const input: PreviewWorkflowImportInput = {
    ...rawInput,
    manifest: parsed.manifest,
    bindings: parsed.bindings,
  };
  return context.transact(
    input.workspaceId,
    input.actorId,
    async (client) => {
      await requirePortabilityAuthority(client, input, { write: true });
      const selection = context.catalogs;
      try {
        const report = await inspectImport(client, context, input, selection);
        return {
          manifestDigest: await portableManifestDigest(input.manifest),
          compatibilityFingerprint: workflowDefinitionCatalogFingerprint(
            selection.definitionCatalog,
          ),
          compatible: report.hard.length === 0,
          issues: report.issues.slice(0, WORKFLOW_PORTABILITY_LIMITS.issues),
          truncated: report.issues.length > WORKFLOW_PORTABILITY_LIMITS.issues,
          connectionSlots: input.manifest.connectionSlots,
        };
      } catch (error) {
        portableFailure(error);
      }
    },
    input.signal,
  );
}

function importPortableWorkflow(
  context: WorkflowAuthoringWriteContext,
  rawInput: ImportWorkflowInput,
) {
  canonicalWorkflowPortableJson({
    manifest: rawInput.manifest,
    bindings: rawInput.bindings,
  });
  const {
    templateIssues: _verification,
    templateOrigin: _origin,
    ...unverified
  } = rawInput;
  const parsed = importInput.parse(unverified);
  const input: ImportWorkflowInput = {
    ...rawInput,
    name: parsed.name,
    manifest: parsed.manifest,
    bindings: parsed.bindings,
  };
  return context.transact(
    input.workspaceId,
    input.actorId,
    async (client) => {
      await requirePortabilityAuthority(client, input, { write: true });
      const destinationId = generatePersistedId();
      const commandDigest = workflowImportCommandDigest(input);
      const command = {
        workspaceId: input.workspaceId,
        operation: 'workflow.import',
        scope: credentialCommandScope(input.actorId, input.commandCredentialId),
        idempotencyKey: input.idempotencyKey,
      };
      const stored = await claimCommand(client, {
        ...command,
        request: commandDigest,
        resourceId: destinationId,
      });
      if (stored !== null) {
        const replay = importResultSchema.parse(stored);
        const destination = await client.query(
          'select id from app.workflows where workspace_id=$1 and id=$2 for share',
          [input.workspaceId, replay.workflowId],
        );
        if (destination.rowCount !== 1)
          throw new WorkflowNotFoundError(
            'Workflow destination is not visible',
          );
        return Object.freeze(replay);
      }
      const selection = context.catalogs;
      if (
        workflowDefinitionCatalogFingerprint(selection.definitionCatalog) !==
        input.expectedCompatibilityFingerprint
      )
        throw new WorkflowPortabilityCompatibilityConflictError(
          'Workflow import catalog changed; preview again',
        );
      let graph;
      try {
        const report = await inspectImport(client, context, input, selection);
        if (report.hard.length !== 0)
          throw new WorkflowPortabilityValidationError(
            report.issues.slice(0, WORKFLOW_PORTABILITY_LIMITS.issues),
            {
              truncated:
                report.issues.length > WORKFLOW_PORTABILITY_LIMITS.issues,
            },
          );
        graph = report.graph;
      } catch (error) {
        portableFailure(error);
      }
      await requireWorkflowCallTargets(client, input, graph);
      await requireConnectionBindings(client, input, graph);
      await lockArtifactReferences(
        client,
        input.workspaceId,
        graph,
        input.actorId,
      );
      await client.query(
        `insert into app.workflows
           (id, workspace_id, name, lifecycle_status, activation_status, created_by)
         values ($1, $2, $3, 'active', 'inactive', $4)`,
        [destinationId, input.workspaceId, input.name, input.actorId],
      );
      await client.query(
        `insert into app.workflow_drafts
           (workflow_id, workspace_id, revision, graph_json, updated_by)
         values ($1, $2, 1, $3::json, $4)`,
        [
          destinationId,
          input.workspaceId,
          JSON.stringify(graph),
          input.actorId,
        ],
      );
      if (input.templateOrigin !== undefined)
        await client.query(
          `insert into app.workflow_template_origins (workspace_id, workflow_id, origin)
           values ($1, $2, $3::jsonb)`,
          [
            input.workspaceId,
            destinationId,
            JSON.stringify({
              ...input.templateOrigin,
              creationCommandDigest: commandDigest,
              derivation: 'direct',
            }),
          ],
        );
      await client.query(
        `insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
      values($1,$2,$3,'workflow.imported','workflow',$4,$5,$6,'{"revision":1}'::jsonb)`,
        [
          generatePersistedId(),
          input.workspaceId,
          input.actorId,
          destinationId,
          input.requestId ?? null,
          input.traceId ?? null,
        ],
      );
      const result = Object.freeze({ workflowId: destinationId });
      await completeCommand(client, command, result);
      return result;
    },
    input.signal,
  );
}

export function createWorkflowPortabilityStore(
  context: WorkflowAuthoringWriteContext,
): Pick<
  WorkflowAuthoringDatabase,
  'exportWorkflow' | 'previewWorkflowImport' | 'importWorkflow'
> {
  return {
    exportWorkflow: (input) => exportPortableWorkflow(context, input),
    previewWorkflowImport: (input) => previewPortableWorkflow(context, input),
    importWorkflow: (input) => importPortableWorkflow(context, input),
  };
}
