import { createHash } from 'node:crypto';

import { z } from 'zod';
import {
  verifyCuratedTemplateManifest,
  workflowTemplateOriginRequestSchema,
} from '@pertexo/templates';
import {
  canonicalWorkflowPortableJson,
  EMPTY_WORKFLOW_GRAPH,
  inspectWorkflowPortableManifest,
  portableConnectionBindingSchema,
  portableGraphDigest,
  type PortableIssue,
  portableManifestDigest,
  projectWorkflowPortableManifest,
  WORKFLOW_PORTABILITY_LIMITS,
  WorkflowPortabilityError,
  workflowPortableManifestSchema,
} from '@pertexo/workflow-model';
import { workflowDefinitionCatalogFingerprint } from '@pertexo/workflow-model/server';

import { claimCommand, completeCommand } from '../../platform/idempotency.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { rolesForCapability } from '../../tenant-access/policy.js';
import type {
  ExportWorkflowInput,
  ImportWorkflowInput,
  PreviewWorkflowImportInput,
  WorkflowAuthoringDatabase,
} from '../workflows/contracts.js';
import type { WorkflowAuthoringWriteContext } from '../workflows/context.js';
import type { PortableCatalog } from '../workflows/types.js';
import {
  WorkflowNotFoundError,
  WorkflowPortabilityCompatibilityConflictError,
  WorkflowPortabilityReviewConflictError,
  WorkflowPortabilityUnavailableError,
  WorkflowPortabilityValidationError,
} from '../workflows/errors.js';
import { admitWorkflowAuthoring } from '../workflows/admission.js';
import { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import {
  inspectPortableConnections,
  lockPortableSource,
  reviewedSourceGraph,
} from './source-authority.js';
import type { AuthoringCatalogs } from '../workflows/catalogs.js';

const scope = z.object({
  workspaceId: z.uuid(),
  actorId: z.uuid(),
  signal: z.instanceof(AbortSignal).optional(),
  requestId: z.string().max(128).optional(),
  traceId: z.string().max(128).optional(),
});
const previewInput = scope
  .extend({
    manifest: workflowPortableManifestSchema,
    bindings: z
      .array(portableConnectionBindingSchema)
      .max(WORKFLOW_PORTABILITY_LIMITS.connectionSlots),
    templateOrigin: workflowTemplateOriginRequestSchema.optional(),
  })
  .strict();
const importInput = previewInput
  .extend({
    name: z.string().trim().min(1).max(128),
    expectedCompatibilityFingerprint: z
      .string()
      .regex(/^wf-compat:v1:sha256:[a-f0-9]{64}$/u),
    idempotencyKey: z.string(),
  })
  .strict();
const importResultSchema = z.object({ workflowId: z.uuid() }).strict();
const exportInput = scope
  .extend({
    workflowId: z.uuid(),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('draft') }).strict(),
      z.object({ kind: z.literal('version'), versionId: z.uuid() }).strict(),
    ]),
    reviewedGraphDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    representationTag: z
      .string()
      .regex(/^"draft-v1\.[A-Za-z0-9_-]{43}"$/u)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.source.kind !== 'draft' || value.representationTag !== undefined,
  );

function selectedPolicy(selection: AuthoringCatalogs) {
  const catalog = selection.portableCatalog;
  if (catalog === undefined)
    throw new WorkflowPortabilityUnavailableError(
      'Workflow portability catalog is not configured',
    );
  return catalog;
}

/** A template origin must name a curated template and change only its setup values. */
function inspectTemplateOrigin(
  input: PreviewWorkflowImportInput,
  catalog: PortableCatalog,
): readonly PortableIssue[] {
  if (input.templateOrigin === undefined) return [];
  const verified = verifyCuratedTemplateManifest(
    input.manifest,
    input.templateOrigin,
  );
  if (!verified.ok) return verified.issues;
  if (catalog.validateTemplateSetup === undefined)
    throw new WorkflowPortabilityUnavailableError(
      'Registered template setup validation is unavailable',
    );
  if (!catalog.validateTemplateSetup(input.manifest, input.templateOrigin))
    return [
      {
        code: 'template_setup_invalid',
        path: '$.manifest',
        message:
          'Template setup does not satisfy the registered serving policy.',
      },
    ];
  return [];
}

async function requirePortabilityAuthority(
  client: Parameters<typeof lockWorkflowAuthoringAuthority>[0],
  input: Readonly<{ workspaceId: string; actorId: string }>,
  write: boolean,
): Promise<void> {
  await lockWorkflowAuthoringAuthority(
    client,
    input.workspaceId,
    input.actorId,
    rolesForCapability(write ? 'workflow:create' : 'workflow:read'),
  );
}

/** The import command's digest, which a template origin records. */
export function workflowImportCommandDigest(
  input: ImportWorkflowInput,
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

async function inspectImport(
  client: Parameters<typeof lockWorkflowAuthoringAuthority>[0],
  context: WorkflowAuthoringWriteContext,
  input: PreviewWorkflowImportInput,
  selection: AuthoringCatalogs,
) {
  const catalog = selectedPolicy(selection);
  const inspected = inspectWorkflowPortableManifest(
    input.manifest,
    input.bindings,
    catalog,
  );
  context.requirePlaceable(
    EMPTY_WORKFLOW_GRAPH,
    inspected.graph,
    selection.placementDefinitionCatalog ?? selection.definitionCatalog,
  );
  const admission = await admitWorkflowAuthoring(
    client,
    selection.validateAuthoringGraph,
    inspected.graph,
    input.signal,
  );
  const issues: PortableIssue[] = [
    ...inspectTemplateOrigin(input, catalog),
    ...inspected.issues,
    ...admission.issues.map(({ code, path }) => ({
      code,
      path: path.slice(0, 2048),
      message: 'The graph is not valid under the serving authoring policy.',
    })),
  ];
  issues.push(
    ...(await inspectPortableConnections(
      client,
      input.workspaceId,
      input.manifest,
      input.bindings,
    )),
  );
  const hard = issues.filter(
    ({ code }) =>
      ![
        'cycle',
        'loop_iteration_limit',
        'expansion_limit',
        'invalid_loop_limit',
      ].includes(code),
  );
  return { graph: inspected.graph, issues, hard };
}

function portableFailure(error: unknown): never {
  if (error instanceof WorkflowPortabilityError)
    throw new WorkflowPortabilityValidationError(
      error.issues.slice(0, WORKFLOW_PORTABILITY_LIMITS.issues),
      error.issues.length > WORKFLOW_PORTABILITY_LIMITS.issues,
    );
  throw error;
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
      await requirePortabilityAuthority(client, input, false);
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
          input.signal,
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
            admission.issues.length > WORKFLOW_PORTABILITY_LIMITS.issues,
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
  const parsed = previewInput.parse(rawInput);
  const input: PreviewWorkflowImportInput = {
    ...rawInput,
    manifest: parsed.manifest,
    bindings: parsed.bindings,
  };
  return context.transact(
    input.workspaceId,
    input.actorId,
    async (client) => {
      await requirePortabilityAuthority(client, input, true);
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
  const parsed = importInput.parse(rawInput);
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
      await requirePortabilityAuthority(client, input, true);
      const destinationId = generatePersistedId();
      const commandDigest = workflowImportCommandDigest(input);
      const command = {
        workspaceId: input.workspaceId,
        operation: 'workflow.import',
        scope: input.actorId,
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
            report.issues.length > WORKFLOW_PORTABILITY_LIMITS.issues,
          );
        graph = report.graph;
      } catch (error) {
        portableFailure(error);
      }
      await client.query(
        `insert into app.workflows
           (id, workspace_id, name, lifecycle_status, activation_status, created_by)
         values ($1, $2, $3, 'active', 'inactive', $4)`,
        [destinationId, input.workspaceId, input.name, input.actorId],
      );
      await client.query(
        `insert into app.workflow_drafts
           (workflow_id, workspace_id, revision, schema_version, graph_json, updated_by)
         values ($1, $2, 1, $3, $4::jsonb, $5)`,
        [
          destinationId,
          input.workspaceId,
          graph.schemaVersion,
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
