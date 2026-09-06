import { createHash } from 'node:crypto';
import { z } from 'zod';

import {
  canonicalJson,
  canonicalizeJson,
  type JsonValue,
} from '../canonical-json.js';
import {
  WORKFLOW_VALIDATION_MAX_ISSUES,
  type WorkflowGraph,
} from '../graph-contract.js';
import { parseWorkflowGraphDraft } from './preflight.js';
import { validateWorkflowGraph } from './validation.js';
import {
  InvalidWorkflowGraphError,
  type GraphValidationIssue,
} from './validation-contract.js';

export interface WorkflowDefinitionCatalogV1 {
  readonly schemaVersion: 1;
  /** Full durable release identity selected by the serving artifact. */
  readonly releaseFingerprint?: string;
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

export const EMPTY_DEFINITION_CATALOG_V1: WorkflowDefinitionCatalogV1 =
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

function definitionCatalogFingerprint(
  catalog: WorkflowDefinitionCatalogV1,
): string {
  if (catalog.releaseFingerprint !== undefined) {
    if (
      !/^node-compat:v1:sha256:[0-9a-f]{64}$/u.test(catalog.releaseFingerprint)
    ) {
      throw new TypeError('Workflow definition catalog release is invalid');
    }
    return catalog.releaseFingerprint;
  }
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
  return `wf-compat:v1:sha256:${digest}`;
}

/**
 * Derive the exact integration index from a graph and its pinned definition
 * catalog. The result is disposable: the graph remains the sole authority.
 */
export function workflowIntegrationUsage(
  input: unknown,
  catalog: WorkflowDefinitionCatalogV1 = EMPTY_DEFINITION_CATALOG_V1,
): readonly WorkflowIntegrationUsage[] {
  const graph = parseWorkflowGraphDraft(input);
  const definitions = new Map(
    catalog.definitions.map((definition) => [
      `${definition.key}\u0000${String(definition.version)}`,
      definition.integration,
    ]),
  );
  const usages = new Map<string, WorkflowIntegrationUsage>();
  const pending: WorkflowGraph[] = [graph];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    for (const node of current.nodes) {
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
      if (node.structured !== undefined) pending.push(node.structured.body);
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

export const EMPTY_DEFINITION_CATALOG_FINGERPRINT_V1 =
  definitionCatalogFingerprint(EMPTY_DEFINITION_CATALOG_V1);

function compatibilityForGraph(
  graph: WorkflowGraph,
  catalog: WorkflowDefinitionCatalogV1,
): WorkflowCompatibilityReport {
  const known = new Set(
    catalog.definitions.map(
      (definition) => `${definition.key}\u0000${String(definition.version)}`,
    ),
  );
  const unknown = new Map<string, WorkflowCompatibilityIssue>();
  const stack: WorkflowGraph[] = [graph];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    for (const node of current.nodes) {
      const identity = `${node.definition.key}\u0000${String(node.definition.version)}`;
      if (!known.has(identity))
        unknown.set(identity, {
          code: 'unknown_definition',
          definitionKey: node.definition.key,
          version: node.definition.version,
        });
      if (node.structured !== undefined) stack.push(node.structured.body);
    }
  }
  const issues = [...unknown.values()].sort(
    (left, right) =>
      compareOrdinal(left.definitionKey, right.definitionKey) ||
      left.version - right.version,
  );
  return {
    compatible: issues.length === 0,
    fingerprint: definitionCatalogFingerprint(catalog),
    issues,
  };
}

export function workflowCompatibilityReport(
  input: unknown,
  catalog: WorkflowDefinitionCatalogV1 = EMPTY_DEFINITION_CATALOG_V1,
): WorkflowCompatibilityReport {
  return compatibilityForGraph(parseWorkflowGraphDraft(input), catalog);
}

export function parseWorkflowGraphForPublish(
  input: unknown,
  catalog: WorkflowDefinitionCatalogV1 = EMPTY_DEFINITION_CATALOG_V1,
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

function executableGraphProjection(
  graph: WorkflowGraph,
): Readonly<Record<string, JsonValue>> {
  return canonicalizeJson({
    schemaVersion: graph.schemaVersion,
    nodes: [...graph.nodes]
      .sort((left, right) => compareOrdinal(left.id, right.id))
      .map((node) => {
        const projected: Record<string, JsonValue> = {
          id: node.id,
          definition: node.definition,
          configVersion: node.configVersion,
          config: node.config,
          inputMappings: node.inputMappings,
          connectionRefs: node.connectionRefs,
          disabled: node.disabled ?? false,
        };
        if (node.structured !== undefined) {
          projected.structured = {
            kind: node.structured.kind,
            maxIterations: node.structured.maxIterations,
            maxConcurrency: node.structured.maxConcurrency,
            body: {
              ...executableGraphProjection(node.structured.body),
              inputPorts: node.structured.body.inputPorts,
              outputPorts: node.structured.body.outputPorts,
            },
          };
        }
        return projected;
      }),
    edges: [...graph.edges]
      .sort((left, right) => compareOrdinal(left.id, right.id))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })),
    settings:
      graph.settings.maxRunDurationMs === undefined
        ? {}
        : { maxRunDurationMs: graph.settings.maxRunDurationMs },
  }) as Readonly<Record<string, JsonValue>>;
}

export function workflowExecutableProjection(
  input: unknown,
  catalog: WorkflowDefinitionCatalogV1 = EMPTY_DEFINITION_CATALOG_V1,
): JsonValue {
  return executableGraphProjection(
    parseWorkflowGraphForPublish(input, catalog),
  );
}

export function workflowExecutableChecksum(
  input: unknown,
  catalog: WorkflowDefinitionCatalogV1 = EMPTY_DEFINITION_CATALOG_V1,
): string {
  return checksumExecutableProjection(
    workflowExecutableProjection(input, catalog),
  );
}

function checksumExecutableProjection(projection: JsonValue): string {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        domain: 'pertexo.workflow.executable',
        checksumVersion: 1,
        graph: projection,
      }),
    )
    .digest('hex');
  return `wf:v1:sha256:${digest}`;
}

/**
 * Recomputes the canonical identity of a retained V1 version without requiring
 * its pinned definitions to remain in the active publication catalog.
 * Structural and graph-semantic corruption still fails closed.
 */
export function workflowRetainedExecutableChecksum(input: unknown): string {
  const graph = parseWorkflowGraphDraft(input);
  const validation = validateWorkflowGraph(graph);
  if (!validation.ok) throw new InvalidWorkflowGraphError(validation.issues);
  return checksumExecutableProjection(executableGraphProjection(graph));
}

export interface RetainedWorkflowVersionV1 {
  readonly format: 'v1';
  readonly executable: false;
  readonly graphSchemaVersion: 1;
  readonly graph: WorkflowGraph;
  readonly checksum: `wf:v1:sha256:${string}`;
}

type WorkflowChecksumV1 = `wf:v1:sha256:${string}`;
const workflowChecksumV1Pattern = /^wf:v1:sha256:[a-f0-9]{64}$/u;
const workflowChecksumV1Schema = z.custom<WorkflowChecksumV1>(
  (value) => typeof value === 'string' && workflowChecksumV1Pattern.test(value),
  'invalid workflow V1 checksum',
);

const retainedWorkflowVersionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    graphJson: z.unknown(),
    checksum: workflowChecksumV1Schema,
    executableSchemaVersion: z.null(),
    executableJson: z.null(),
    compatibilityReleaseEpoch: z.null(),
  })
  .strict();

/**
 * Verifies a retained Phase 2 row under its original V1 identity rules.
 * V1 remains readable for diagnosis and migration, but deliberately cannot be
 * admitted for execution because it has no pinned executor or runtime policy.
 */
export function parseRetainedWorkflowVersionV1(
  input: unknown,
): RetainedWorkflowVersionV1 {
  const retained = retainedWorkflowVersionV1Schema.parse(input);
  const graph = parseWorkflowGraphDraft(retained.graphJson);
  const checksum = workflowRetainedExecutableChecksum(graph);
  if (checksum !== retained.checksum)
    throw new Error('retained workflow V1 checksum does not match its graph');
  return Object.freeze({
    format: 'v1',
    executable: false,
    graphSchemaVersion: 1,
    graph,
    checksum: retained.checksum,
  });
}

export type WorkflowDraftRepresentationTag = `"draft-v1.${string}"`;

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
        tagVersion: 1,
        workflowId,
        revision,
        schemaVersion: graph.schemaVersion,
        graph,
        compatibilityFingerprint,
      }),
    )
    .digest('base64url');
  return `"draft-v1.${digest}"`;
}
