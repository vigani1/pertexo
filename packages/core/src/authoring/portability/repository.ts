import {
  appendAuditFact,
  rethrowQueryFailure,
  claimCommand,
  completeCommand,
} from '@pertexo/database/primitives';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { lockArtifactReferences } from '../../artifacts/references/repository.js';
import {
  workflowTemplateOrigins,
  workflowDrafts,
  workflows,
} from '@pertexo/database/schema';
import { requireWorkflowCallTargets } from '../../tenant-access/resources/bindings.queries.js';
import { requireConnectionBindings } from '../../tenant-access/resources/connections/bindings.queries.js';

import {
  canonicalWorkflowPortableJson,
  portableGraphDigest,
  portableManifestDigest,
  projectWorkflowPortableManifest,
  rolesForCapability,
  WORKFLOW_PORTABILITY_LIMITS,
} from '@pertexo/workflow-model';
import { workflowDefinitionCatalogFingerprint } from '@pertexo/workflow-model/server';
import {
  credentialCommandScope,
  generatePersistedId,
} from '@pertexo/database/platform';
import type { WorkflowAuthoringWriteContext } from '../workflows/context.js';
import type {
  ExportWorkflowInput,
  ImportWorkflowInput,
  PreviewWorkflowImportInput,
  WorkflowAuthoringDatabase,
} from '../workflows/contract.js';

import { admitWorkflowAuthoring } from '../workflows/admission.queries.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import {
  WorkflowNotFoundError,
  WorkflowPortabilityCompatibilityConflictError,
  WorkflowPortabilityReviewConflictError,
  WorkflowPortabilityValidationError,
} from '../workflows/errors.js';
import {
  lockPortableSource,
  reviewedSourceGraph,
} from './source-authority.queries.js';

import { inspectImport, portableFailure, selectedPolicy } from './admission.js';
import { importResultSchema } from './input.js';

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
  input: PreviewWorkflowImportInput,
) {
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
  input: ImportWorkflowInput,
) {
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
        const destination = await drizzle(client)
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            and(
              eq(workflows.workspaceId, input.workspaceId),
              eq(workflows.id, replay.workflowId),
            ),
          )
          .for('share')
          .catch(rethrowQueryFailure);
        if (destination.length !== 1)
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
      await persistImportedWorkflow(client, input, {
        destinationId,
        graph,
        commandDigest,
      });
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

async function persistImportedWorkflow(
  client: PoolClient,
  input: ImportWorkflowInput,
  {
    destinationId,
    graph,
    commandDigest,
  }: Readonly<{
    destinationId: string;
    graph: WorkflowGraph;
    commandDigest: string;
  }>,
): Promise<void> {
  const db = drizzle(client);
  await db
    .insert(workflows)
    .values({
      id: destinationId,
      workspaceId: input.workspaceId,
      name: input.name,
      lifecycleStatus: 'active',
      activationStatus: 'inactive',
      createdBy: input.actorId,
    })
    .catch(rethrowQueryFailure);
  await db
    .insert(workflowDrafts)
    .values({
      workflowId: destinationId,
      workspaceId: input.workspaceId,
      revision: 1,
      graphJson: graph,
      updatedBy: input.actorId,
    })
    .catch(rethrowQueryFailure);
  if (input.templateOrigin !== undefined)
    await db
      .insert(workflowTemplateOrigins)
      .values({
        workspaceId: input.workspaceId,
        workflowId: destinationId,
        origin: {
          ...input.templateOrigin,
          creationCommandDigest: commandDigest,
          derivation: 'direct',
        },
      })
      .catch(rethrowQueryFailure);
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: 'workflow.imported',
    targetType: 'workflow',
    targetId: destinationId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata: { revision: 1 },
  });
}
