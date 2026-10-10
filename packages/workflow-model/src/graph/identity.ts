import { createHash } from 'node:crypto';
import { z } from 'zod';

import { canonicalJson } from '../json/canonical-json.js';
import {
  WORKFLOW_VALIDATION_MAX_ISSUES,
  type WorkflowGraph,
} from './contract.js';
import { parseWorkflowGraphDraft } from './preflight.js';
import { validateWorkflowGraph } from './validation.js';
import {
  InvalidWorkflowGraphError,
  type GraphValidationIssue,
} from './validation-contract.js';

export interface WorkflowDefinitionCatalog {
  readonly schemaVersion: 1;
  readonly definitions: readonly {
    readonly key: string;
    readonly version: number;
    /** Optional projection metadata; it does not participate in compatibility identity. */
    readonly integration?: Readonly<{
      readonly providerKey: string;
      readonly operationKey: string;
      readonly connectionSlots: readonly string[];
    }>;
  }[];
}

export type WorkflowIntegrationUsage = Readonly<{
  providerKey: string;
  operationKey: string;
  connectionId: string;
}>;

export const EMPTY_DEFINITION_CATALOG: WorkflowDefinitionCatalog =
  Object.freeze({ schemaVersion: 1, definitions: Object.freeze([]) });

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

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Identifies which definitions a catalog offers; it changes when one is added or removed. */
export function workflowDefinitionCatalogFingerprint(
  catalog: WorkflowDefinitionCatalog,
): string {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        domain: 'pertexo.workflow.definition-compatibility',
        catalogVersion: catalog.schemaVersion,
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

/**
 * Enumerate every node with the same stack order previously used by the two
 * identity projections. The graph remains authoritative; callers retain their
 * own deduplication, validation and ordering policies.
 */
function* workflowNodes(graph: WorkflowGraph) {
  const pending: WorkflowGraph[] = [graph];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    for (const node of current.nodes) {
      yield node;
      if (node.structured !== undefined) pending.push(node.structured.body);
    }
  }
}

/**
 * Derive the exact integration index from a graph and its pinned definition
 * catalog. The result is disposable: the graph remains the sole authority.
 */
export function workflowIntegrationUsage(
  input: unknown,
  catalog: WorkflowDefinitionCatalog = EMPTY_DEFINITION_CATALOG,
): readonly WorkflowIntegrationUsage[] {
  const graph = parseWorkflowGraphDraft(input);
  const definitions = new Map(
    catalog.definitions.map((definition) => [
      `${definition.key}\u0000${String(definition.version)}`,
      definition.integration,
    ]),
  );
  const usages = new Map<string, WorkflowIntegrationUsage>();
  for (const node of workflowNodes(graph)) {
    const integration = definitions.get(
      `${node.definition.key}\u0000${String(node.definition.version)}`,
    );
    if (integration !== undefined) {
      for (const slot of integration.connectionSlots) {
        const connectionId = node.connectionRefs[slot];
        if (connectionId === undefined) {
          throw new TypeError(
            `Integration definition ${node.definition.key}@${String(node.definition.version)} requires connection slot ${slot}`,
          );
        }
        const usage = Object.freeze({
          providerKey: integration.providerKey,
          operationKey: integration.operationKey,
          connectionId,
        });
        usages.set(
          `${usage.providerKey}\u0000${usage.operationKey}\u0000${usage.connectionId}`,
          usage,
        );
      }
    }
  }
  return Object.freeze(
    [...usages.values()].sort(
      (left, right) =>
        compareOrdinal(left.providerKey, right.providerKey) ||
        compareOrdinal(left.operationKey, right.operationKey) ||
        compareOrdinal(left.connectionId, right.connectionId),
    ),
  );
}

function compatibilityForGraph(
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

export function parseWorkflowGraphForPublish(
  input: unknown,
  catalog: WorkflowDefinitionCatalog = EMPTY_DEFINITION_CATALOG,
): WorkflowGraph {
  const graph = parseWorkflowGraphDraft(input);
  const validation = validateWorkflowGraph(graph);
  const compatibility = compatibilityForGraph(graph, catalog);
  const compatibilityIssues: GraphValidationIssue[] = compatibility.issues.map(
    (issue) => ({
      code: 'unknown_definition',
      path: '$.nodes',
      message: `unknown definition ${issue.definitionKey}@${String(issue.version)}`,
    }),
  );
  const issues = (
    validation.ok
      ? compatibilityIssues
      : [...validation.issues, ...compatibilityIssues]
  ).slice(0, WORKFLOW_VALIDATION_MAX_ISSUES);
  if (issues.length > 0) throw new InvalidWorkflowGraphError(issues);
  return graph;
}

export type WorkflowDraftRepresentationTag = `"draft.${string}"`;

export function workflowDraftRepresentationTag(input: {
  readonly workflowId: string;
  readonly revision: number;
  readonly graph: unknown;
  readonly compatibilityFingerprint: string;
}): WorkflowDraftRepresentationTag {
  const workflowId = z.uuid().parse(input.workflowId);
  const revision = z.number().int().positive().parse(input.revision);
  const graph = parseWorkflowGraphDraft(input.graph);
  const compatibilityFingerprint = z
    .string()
    .min(1)
    .max(256)
    .parse(input.compatibilityFingerprint);
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        domain: 'pertexo.workflow.draft-representation',
        workflowId,
        revision,
        schemaVersion: graph.schemaVersion,
        graph,
        compatibilityFingerprint,
      }),
    )
    .digest('base64url');
  return `"draft.${digest}"`;
}
