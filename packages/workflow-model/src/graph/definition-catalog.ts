import { createHash } from 'node:crypto';
import { canonicalJson } from '../values/json/canonical.js';
import { compareOrdinal } from '../values/ordering.js';
import { workflowNodes } from './nodes.js';
import type { WorkflowGraph } from './workflow-graph.schemas.js';
import { parseWorkflowGraphDraft } from './validation/preflight.js';
export interface WorkflowDefinitionCatalog {
  readonly definitions: readonly {
    readonly key: string;
    readonly version: number;
    /** Optional projection metadata; it does not participate in compatibility identity. */
    readonly integration?: Readonly<{
      readonly providerKey: string;
      readonly operationKey: string;
      readonly connectionSlots: readonly string[];
      /** Slots a step may leave empty, such as auth for a public API. */
      readonly optionalConnectionSlots?: readonly string[];
    }>;
  }[];
}

export const EMPTY_DEFINITION_CATALOG: WorkflowDefinitionCatalog =
  Object.freeze({ definitions: Object.freeze([]) });

export interface WorkflowCompatibilityIssue {
  readonly code: 'unknown_definition';
  readonly definitionKey: string;
  readonly version: number;
}

export interface WorkflowCompatibilityReport {
  readonly compatible: boolean;
  readonly fingerprint: string;
  readonly issues: readonly WorkflowCompatibilityIssue[];
}

/** Identifies which definitions a catalog offers; it changes when one is added or removed. */
export function workflowDefinitionCatalogFingerprint(
  catalog: WorkflowDefinitionCatalog,
): string {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        domain: 'pertexo.workflow.definition-compatibility',
        definitions: [...catalog.definitions]
          .map(({ key, version }) => ({ key, version }))
          .sort(
            (left, right) =>
              compareOrdinal(left.key, right.key) ||
              left.version - right.version,
          ),
      }),
    )
    .digest('hex');
  return `wf-compat:sha256:${digest}`;
}

export function compatibilityForGraph(
  graph: WorkflowGraph,
  catalog: WorkflowDefinitionCatalog,
): WorkflowCompatibilityReport {
  const known = new Set(
    catalog.definitions.map(
      (definition) => `${definition.key}\u0000${String(definition.version)}`,
    ),
  );
  const unknown = new Map<string, WorkflowCompatibilityIssue>();
  for (const node of workflowNodes(graph)) {
    const identity = `${node.definition.key}\u0000${String(node.definition.version)}`;
    if (!known.has(identity))
      unknown.set(identity, {
        code: 'unknown_definition',
        definitionKey: node.definition.key,
        version: node.definition.version,
      });
  }
  const issues = [...unknown.values()].sort(
    (left, right) =>
      compareOrdinal(left.definitionKey, right.definitionKey) ||
      left.version - right.version,
  );
  return {
    compatible: issues.length === 0,
    fingerprint: workflowDefinitionCatalogFingerprint(catalog),
    issues,
  };
}

export function workflowCompatibilityReport(
  input: unknown,
  catalog: WorkflowDefinitionCatalog = EMPTY_DEFINITION_CATALOG,
): WorkflowCompatibilityReport {
  return compatibilityForGraph(parseWorkflowGraphDraft(input), catalog);
}
