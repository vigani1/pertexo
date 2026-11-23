import { workflowValidateResponseSchema } from '@pertexo/contracts';
import type { WorkflowAuthoringStore } from '@pertexo/core/authoring';
import {
  safeParseWorkflowGraphDraft,
  startingConfig,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model';
import type { ListNodeDefinitionsService } from '../../catalog/index.js';
import { setupRequiresUser } from '../../platform/workflow/step-setup.validation.js';
import { restoreDraftFields } from './masked-draft.js';

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
  const parsed = safeParseWorkflowGraphDraft(graph);
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
  const restored = restoreDraftFields(draft.graphJson, parsed.data);
  if (restored.kind === 'rejected')
    return rejected(
      restored.issues,
      restored.issues.filter(({ code }) => code === 'masked_value_changed'),
    );
  const admitted = safeParseWorkflowGraphDraft({
    ...restored.graph,
    nodes: initializeAddedSteps(
      draft.graphJson.nodes,
      restored.graph.nodes,
      catalog.execute().items,
    ),
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
    feedback: publicationFeedback(
      inspected.graphIssues,
      parsed.data,
      restored.graph,
    ),
  };
}

function initializeAddedSteps(
  previous: readonly WorkflowNode[],
  level: readonly WorkflowNode[],
  catalog: ReturnType<ListNodeDefinitionsService['execute']>['items'],
): readonly WorkflowNode[] {
  const existing = new Map(previous.map((node) => [node.id, node]));
  return level.map((node) => {
    const original = existing.get(node.id);
    const definition =
      original === undefined
        ? catalog.find(
            (item) =>
              item.definition.key === node.definition.key &&
              item.definition.version === node.definition.version,
          )
        : undefined;
    const config =
      definition === undefined
        ? node.config
        : startingConfig(definition, level, node.config);
    const { structured } = node;
    if (structured === undefined) return { ...node, config };
    return {
      ...node,
      config,
      structured: {
        ...structured,
        body: {
          ...structured.body,
          nodes: initializeAddedSteps(
            original?.structured?.body.nodes ?? [],
            structured.body.nodes,
            catalog,
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
  const parsed = workflowValidateResponseSchema.shape.issues.safeParse(issues);
  return parsed.success
    ? { kind: 'rejected' as const, issues: parsed.data, feedback }
    : { kind: 'invalid_response' as const };
}

function publicationFeedback(
  issues: readonly ProposalIssue[],
  submitted: WorkflowGraph,
  restored: WorkflowGraph,
) {
  // Both path styles must use candidate order, which may differ from the base.
  const protectedPaths = ['$.callable', '$.notes'];
  const levels = [{ submitted, restored, idPath: '$', indexPath: '$' }];
  for (const level of levels)
    for (const [index, node] of level.restored.nodes.entries()) {
      const original = level.submitted.nodes[index];
      if (original === undefined) continue;
      const idPath = `${level.idPath}.nodes.${node.id}`;
      const indexPath = `${level.indexPath}.nodes[${String(index)}]`;
      for (const field of [
        'config',
        'inputMappings',
        'connectionRefs',
      ] as const)
        if (node[field] !== original[field])
          protectedPaths.push(`${idPath}.${field}`, `${indexPath}.${field}`);
      if (node.structured !== undefined && original.structured !== undefined)
        levels.push({
          submitted: original.structured.body,
          restored: node.structured.body,
          idPath: `${idPath}.structured.body`,
          indexPath: `${indexPath}.structured.body`,
        });
    }
  return issues.filter(
    (issue) =>
      !(setupRequiresUser in issue && issue[setupRequiresUser]) &&
      !issue.path.includes('.connectionRefs.') &&
      !protectedPaths.some(
        (path) =>
          issue.path === path ||
          issue.path.startsWith(`${path}.`) ||
          issue.path.startsWith(`${path}[`),
      ),
  );
}
