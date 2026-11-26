import { workflowValidateResponseSchema } from '@pertexo/contracts';
import type { WorkflowAuthoringStore } from '@pertexo/core/authoring';
import {
  safeParseWorkflowGraphDraft,
  isRecord,
  placeableDefinitions,
  workflowDefinitionPlacementIssues,
  type GraphValidationIssue,
  startingConfig,
  type WorkflowNode,
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
} from '@pertexo/workflow-model';
import type { ListNodeDefinitionsService } from '../../catalog/index.js';
import { restoreDraftFields } from './masking/restore-draft.js';

type ProposalInspection = Parameters<
  WorkflowAuthoringStore['inspectCandidate']
>[0];

export async function inspectProposalCandidate(
  persistence: Pick<WorkflowAuthoringStore, 'inspectCandidate'>,
  catalog: ListNodeDefinitionsService,
  {
    graph,
    draft,
    actor,
    signal,
  }: Readonly<{
    graph: unknown;
    draft: NonNullable<Awaited<ReturnType<WorkflowAuthoringStore['getDraft']>>>;
    actor: Pick<ProposalInspection, 'workspaceId' | 'workflowId' | 'actorId'>;
    signal: AbortSignal;
  }>,
) {
  const parsed = safeParseWorkflowGraphDraft(withEmptyConnections(graph));
  if (!parsed.success) {
    const issue =
      'issues' in parsed.error
        ? {
            path: '$',
            code: 'invalid_graph',
            message: 'The model returned a malformed draft graph.',
          }
        : {
            path: parsed.error.path,
            code: parsed.error.code,
            message: parsed.error.message,
          };
    return rejected([issue], [issue]);
  }
  const restored = restoreDraftFields(
    draft.graphJson,
    parsed.data,
    catalog.assistantDisclosure,
  );
  if (restored.kind === 'rejected')
    return rejected(restored.issues, restored.feedback);
  const { items, codeSettings } = catalog.execute();
  const placeable = placeableDefinitions(items, codeSettings);
  const placementIssues = workflowDefinitionPlacementIssues(
    draft.graphJson,
    restored.graph,
    { definitions: placeable.map(({ definition }) => definition) },
  );
  if (placementIssues.length > 0)
    return rejected(placementIssues, placementIssues);
  const omittedPresetFields = new Set<string>();
  const admitted = safeParseWorkflowGraphDraft({
    ...restored.graph,
    nodes: initializeAddedSteps(draft.graphJson.nodes, restored.graph.nodes, {
      catalog: placeable,
      omittedPresetFields,
    }),
  });
  if (!admitted.success)
    return rejected(
      [
        {
          path: '$',
          code: 'invalid_graph',
          message: 'The restored graph exceeds the draft contract.',
        },
      ],
      [],
    );
  if (signal.aborted) return { kind: 'timeout' as const };
  const inspected = await persistence
    .inspectCandidate({
      ...actor,
      graph: admitted.data,
      expectedRevision: draft.revision,
      signal,
    })
    .catch((error: unknown) => {
      if (signal.aborted) return undefined;
      throw error;
    });
  if (inspected === undefined) return { kind: 'timeout' as const };
  if (inspected.kind === 'rejected')
    return rejected(
      inspected.issues,
      inspected.issues.filter(
        ({ code }) => code === 'definition_not_placeable',
      ),
    );
  return {
    ...inspected,
    // Restoration accepted it, so it holds the model's own values and
    // placeholders only where saved masked values were put back.
    previousGraph: parsed.data,
    feedback: publicationFeedback(
      inspected.graphIssues,
      restored.protectedPaths,
      omittedPresetFields,
    ),
  };
}

function withEmptyConnections(graph: unknown, depth = 0): unknown {
  if (
    depth > WORKFLOW_GRAPH_CONTRACT_LIMITS.structuredDepth ||
    !isRecord(graph) ||
    !Array.isArray(graph.nodes)
  )
    return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((node: unknown) => {
      if (!isRecord(node)) return node;
      const { structured } = node;
      return {
        connectionRefs: {},
        ...node,
        ...(isRecord(structured)
          ? {
              structured: {
                ...structured,
                body: withEmptyConnections(structured.body, depth + 1),
              },
            }
          : {}),
      };
    }),
  };
}

function initializeAddedSteps(
  previous: readonly WorkflowNode[],
  level: readonly WorkflowNode[],
  {
    catalog,
    omittedPresetFields,
    levelPath = '$',
  }: Readonly<{
    catalog: ReturnType<ListNodeDefinitionsService['execute']>['items'];
    omittedPresetFields: Set<string>;
    levelPath?: string;
  }>,
): readonly WorkflowNode[] {
  const existing = new Map(previous.map((node) => [node.id, node]));
  return level.map((node) => {
    const original = existing.get(node.id);
    const definition =
      original?.definition.key !== node.definition.key ||
      original.definition.version !== node.definition.version
        ? catalog.find(
            (item) =>
              item.definition.key === node.definition.key &&
              item.definition.version === node.definition.version,
          )
        : undefined;
    const config =
      definition === undefined
        ? node.config
        : startingConfig(definition, level, node.config, 'proposal');
    const configVersion = definition?.configVersion ?? node.configVersion;
    const nodePath = `${levelPath}.nodes.${node.id}`;
    const preset = definition?.configSchema.default;
    if (isRecord(preset))
      for (const field of Object.keys(preset))
        if (!Object.hasOwn(config, field))
          omittedPresetFields.add(`${nodePath}.config.${field}`);
    const { structured } = node;
    if (structured === undefined) return { ...node, config, configVersion };
    return {
      ...node,
      config,
      configVersion,
      structured: {
        ...structured,
        body: {
          ...structured.body,
          nodes: initializeAddedSteps(
            original?.structured?.body.nodes ?? [],
            structured.body.nodes,
            {
              catalog,
              omittedPresetFields,
              levelPath: `${nodePath}.structured.body`,
            },
          ),
        },
      },
    };
  });
}

interface ProposalIssue {
  path: string;
  code: string;
  message: string;
}

function rejected(
  issues: readonly ProposalIssue[],
  feedback: readonly ProposalIssue[],
) {
  const parsed = workflowValidateResponseSchema.shape.issues.safeParse(
    issues.map(({ path, code, message }) => ({ path, code, message })),
  );
  return parsed.success
    ? { kind: 'rejected' as const, issues: parsed.data, feedback }
    : { kind: 'invalid_response' as const };
}

function publicationFeedback(
  issues: readonly GraphValidationIssue[],
  protectedPaths: readonly string[],
  omittedPresetFields: ReadonlySet<string>,
) {
  return issues.filter(
    (issue) =>
      (issue.kind !== 'requires_user' || omittedPresetFields.has(issue.path)) &&
      !issue.path.includes('.connectionRefs.') &&
      !protectedPaths.some(
        (path) =>
          issue.path === path ||
          issue.path.startsWith(`${path}.`) ||
          issue.path.startsWith(`${path}[`),
      ),
  );
}
