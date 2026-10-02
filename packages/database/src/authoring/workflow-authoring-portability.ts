import { z } from 'zod';
import { EMPTY_WORKFLOW_GRAPH_V1 } from '@pertexo/workflow-model/graph';
import {
  inspectWorkflowPortableManifest,
  projectWorkflowPortableManifest,
  WorkflowPortabilityError,
} from '@pertexo/workflow-model/portability';
import {
  canonicalWorkflowPortableJson,
  portableGraphDigest,
  portableManifestDigest,
  portableConnectionBindingSchema,
  workflowPortableManifestSchema,
  WORKFLOW_PORTABILITY_LIMITS,
  type PortableIssue,
} from '@pertexo/workflow-model/portability-contract';
import type {
  ExportWorkflowInput,
  ImportWorkflowInput,
  PreviewWorkflowImportInput,
  WorkflowAuthoringDatabase,
} from './workflow-authoring-contracts.js';
import type { WorkflowAuthoringWriteContext } from './workflow-authoring-context.js';
import {
  WorkflowNotFoundError,
  WorkflowPortabilityCompatibilityConflictError,
  WorkflowPortabilityReviewConflictError,
  WorkflowPortabilityUnavailableError,
  WorkflowPortabilityValidationError,
} from './workflow-authoring-errors.js';
import { admitWorkflowAuthoring } from './workflow-authoring-admission.js';
import {
  inspectPortableConnections,
  lockPortableSource,
  requirePortabilityAuthority,
  reviewedSourceGraph,
} from './workflow-portability-authority.js';
import {
  claimWorkflowImport,
  completeWorkflowImport,
} from './workflow-portability-receipts.js';
import { generatePersistedId } from '../platform/persisted-id.js';

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
  })
  .strict();
const importInput = previewInput
  .extend({
    name: z.string().trim().min(1).max(128),
    expectedCompatibilityFingerprint: z
      .string()
      .regex(/^node-compat:v1:sha256:[a-f0-9]{64}$/u),
    idempotencyKey: z.string(),
  })
  .strict();
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

function selectedPolicy(
  selection: Awaited<
    ReturnType<WorkflowAuthoringWriteContext['selectCatalogs']>
  >,
) {
  const catalog = selection.portableCatalog;
  if (catalog === undefined)
    throw new WorkflowPortabilityUnavailableError(
      'Workflow portability catalog is not configured',
    );
  if (catalog.fingerprint !== selection.definitionCatalog.releaseFingerprint)
    throw new WorkflowPortabilityUnavailableError(
      'Workflow portability catalog does not match serving authority',
    );
  return catalog;
}

async function inspectImport(
  client: Parameters<typeof requirePortabilityAuthority>[0],
  context: WorkflowAuthoringWriteContext,
  input: PreviewWorkflowImportInput,
  selection: Awaited<
    ReturnType<WorkflowAuthoringWriteContext['selectCatalogs']>
  >,
) {
  const catalog = selectedPolicy(selection);
  const inspected = inspectWorkflowPortableManifest(
    input.manifest,
    input.bindings,
    catalog,
  );
  context.requirePlaceable(
    EMPTY_WORKFLOW_GRAPH_V1,
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
      await requirePortabilityAuthority(
        client,
        input.workspaceId,
        input.actorId,
        false,
      );
      const row = await lockPortableSource(client, input);
      await context.testHooks?.afterExportSourceLock?.();
      const selection = await context.selectCatalogs(client);
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
      await requirePortabilityAuthority(
        client,
        input.workspaceId,
        input.actorId,
        true,
      );
      const selection = await context.selectCatalogs(client);
      try {
        const report = await inspectImport(client, context, input, selection);
        return {
          manifestDigest: await portableManifestDigest(input.manifest),
          compatibilityFingerprint: selectedPolicy(selection).fingerprint,
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
      await requirePortabilityAuthority(
        client,
        input.workspaceId,
        input.actorId,
        true,
      );
      await context.testHooks?.afterImportStep?.('authority');
      const claim = await claimWorkflowImport(client, context, input);
      await context.testHooks?.afterImportStep?.('claim');
      if (claim.replay !== null) {
        const destination = await client.query(
          'select id from app.workflows where workspace_id=$1 and id=$2 for share',
          [input.workspaceId, claim.replay.workflowId],
        );
        if (destination.rowCount !== 1)
          throw new WorkflowNotFoundError(
            'Workflow destination is not visible',
          );
        return Object.freeze(claim.replay);
      }
      const gate = await client.query<{ import_enabled: boolean }>(
        'select import_enabled from app.workflow_portability_rollout where singleton for share',
      );
      if (gate.rows[0]?.import_enabled !== true)
        throw new WorkflowPortabilityUnavailableError(
          'New workflow imports are disabled',
        );
      const selection = await context.selectCatalogs(client);
      if (
        selectedPolicy(selection).fingerprint !==
        input.expectedCompatibilityFingerprint
      )
        throw new WorkflowPortabilityCompatibilityConflictError(
          'Workflow import catalog changed; preview again',
        );
      await context.testHooks?.afterImportStep?.('catalog');
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
      await context.testHooks?.afterImportStep?.('connections');
      await client.query(
        'select app.create_workflow_import_draft($1,$2,$3,$4::jsonb,$5,$6,$7)',
        [
          claim.destinationId,
          input.workspaceId,
          input.actorId,
          JSON.stringify(graph),
          claim.keyHash,
          claim.requestHash,
          claim.command,
        ],
      );
      await context.testHooks?.afterImportStep?.('workflow');
      await context.testHooks?.afterImportStep?.('draft');
      await client.query(
        `insert into app.audit_events(id,workspace_id,actor_user_id,action,target_type,target_id,request_id,trace_id,metadata)
      values($1,$2,$3,'workflow.imported','workflow',$4,$5,$6,'{"revision":1}'::jsonb)`,
        [
          generatePersistedId(),
          input.workspaceId,
          input.actorId,
          claim.destinationId,
          input.requestId ?? null,
          input.traceId ?? null,
        ],
      );
      await context.testHooks?.afterImportStep?.('audit');
      const result = await completeWorkflowImport(
        client,
        input,
        claim.keyHash,
        claim.destinationId,
      );
      await context.testHooks?.afterImportStep?.('idempotency');
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
