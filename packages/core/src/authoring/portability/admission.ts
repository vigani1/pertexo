import {
  EMPTY_WORKFLOW_GRAPH,
  inspectWorkflowPortableManifest,
  type PortableIssue,
  WORKFLOW_PORTABILITY_LIMITS,
  WorkflowPortabilityError,
} from '@pertexo/workflow-model';

import type { PreviewWorkflowImportInput } from '../workflows/contract.js';
import type { WorkflowAuthoringWriteContext } from '../workflows/context.js';
import type { PortableCatalog } from '../workflows/types.js';
import {
  WorkflowPortabilityUnavailableError,
  WorkflowPortabilityValidationError,
} from '../workflows/errors.js';
import { admitWorkflowAuthoring } from '../workflows/admission.queries.js';
import type { lockWorkflowAuthoringAuthority } from '../workflows/authority.js';
import { inspectPortableConnections } from './source-authority.queries.js';
import type { AuthoringCatalogs } from '../workflows/catalogs.js';

export function selectedPolicy(selection: AuthoringCatalogs) {
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
  if (input.templateIssues.length > 0) return input.templateIssues;
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

export async function inspectImport(
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
    input.signal === undefined ? {} : { signal: input.signal },
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
    ...(await inspectPortableConnections(client, input.workspaceId, {
      actorId: input.actorId,
      manifest: input.manifest,
      bindings: input.bindings,
    })),
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

export function portableFailure(error: unknown): never {
  if (error instanceof WorkflowPortabilityError)
    throw new WorkflowPortabilityValidationError(
      error.issues.slice(0, WORKFLOW_PORTABILITY_LIMITS.issues),
      { truncated: error.issues.length > WORKFLOW_PORTABILITY_LIMITS.issues },
    );
  throw error;
}
