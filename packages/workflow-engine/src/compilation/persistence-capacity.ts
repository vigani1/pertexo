import { WorkflowEngineError } from '../workflow-engine.errors.js';
import {
  reserveCheckpointNode,
  type CapacityCheckpoint,
  type Scope,
} from './checkpoint-capacity.js';
import type { NodeCatalog } from '@pertexo/node-sdk';
import {
  WORKFLOW_FAILURE_PORT,
  InvalidWorkflowGraphError,
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  compareOrdinal,
  utf8ByteLength,
  inspectJsonValue,
  type ControlNodeConfig,
} from '@pertexo/workflow-model';
import { createCheckpoint } from '../checkpoint/create-and-parse.js';
import {
  assertBoundedCheckpointJson,
  WORKFLOW_CHECKPOINT_LIMITS,
} from '../checkpoint/admission.js';
import { invocationKey } from '../transition/scheduling/loops.js';
import {
  configuredScopedOutputPorts,
  configuredParallelOutputPorts,
} from '../transition/scheduling/policy.js';
import type {
  InvocationState,
  WorkflowCheckpoint,
} from '../workflow-execution.js';
import { executableControls } from './verified-executable.js';
import {
  type CompiledWorkflowExecutable,
  type WorkflowExecutableGraph,
} from './workflow-executable.js';

const versionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
type ScopeBounds = Readonly<{ identity: Scope; retained: Scope }>;
const jsonBytes = (value: unknown) => utf8ByteLength(JSON.stringify(value));
const branchKeyBytes = (scope: Scope) =>
  encodeURIComponent(
    scope.branchPath
      .map((part) => `${part.nodeId}:${part.outputPort}`)
      .join('/'),
  ).length;
const keyFor = (nodeId: string, scope: Scope) =>
  invocationKey({
    workflowVersionId: versionId,
    nodeId,
    branchPath: scope.branchPath.map(
      (part) => `${part.nodeId}:${part.outputPort}`,
    ),
    iterationPath: scope.iterationPath,
  });

/** Admission reserves the retained frontier, including out-of-order loop history. */
export function assertExecutablePersistenceCapacity(
  compiled: CompiledWorkflowExecutable,
  catalog: NodeCatalog,
): void {
  const controls = executableControls(compiled);
  const suspendingDefinitions = new Set(
    catalog.definitions
      .filter((definition) => definition.capabilities.includes('suspends_run'))
      .map(
        (definition) =>
          `${definition.definition.key}@${String(definition.definition.version)}`,
      ),
  );
  const checkpoint = {
    ...createCheckpoint({
      workflowVersionId: versionId,
      iterationBudget: WORKFLOW_GRAPH_CONTRACT_LIMITS.maxTotalLoopIterations,
    }),
    revision: Number.MAX_SAFE_INTEGER,
    nextEventSequence: 2_147_483_647,
    retiredIterationBudget:
      WORKFLOW_GRAPH_CONTRACT_LIMITS.maxTotalLoopIterations,
    invocations: [] as InvocationState[],
    readySet: [] as string[],
    admittedInvocationKeys: [] as string[],
    joins: [] as WorkflowCheckpoint['joins'][number][],
    loops: [] as WorkflowCheckpoint['loops'][number][],
    branchSelections: [] as WorkflowCheckpoint['branchSelections'][number][],
  };
  reserveGraph(
    compiled.envelope.graph,
    {
      identity: { branchPath: [], iterationPath: [] },
      retained: { branchPath: [], iterationPath: [] },
    },
    { copies: 1, controls, suspendingDefinitions, checkpoint },
  );
  const capacity = inspectJsonValue(checkpoint);
  try {
    assertBoundedCheckpointJson(checkpoint);
  } catch (error) {
    if (!(error instanceof WorkflowEngineError)) throw error;
    refusePersistenceCapacity(
      '$',
      `Workflow retained scopes exceed checkpoint capacity (estimated ${String(capacity.bytes)} bytes / ${String(capacity.members)} members; maximum ${String(WORKFLOW_CHECKPOINT_LIMITS.bytes)} bytes / ${String(WORKFLOW_CHECKPOINT_LIMITS.members)} members). Shorten step IDs, reduce nesting or reduce Items at a time.`,
    );
  }
}

function reserveGraph(
  graph: WorkflowExecutableGraph,
  inherited: ScopeBounds,
  context: Readonly<{
    copies: number;
    controls: ReadonlyMap<string, ControlNodeConfig>;
    suspendingDefinitions: ReadonlySet<string>;
    checkpoint: CapacityCheckpoint;
  }>,
): void {
  const { copies, controls, suspendingDefinitions, checkpoint } = context;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const scopes = new Map<string, ScopeBounds>();
  const scopeFor = (nodeId: string): ScopeBounds => {
    const cached = scopes.get(nodeId);
    if (cached !== undefined) return cached;
    const node = byId.get(nodeId);
    if (node === undefined) return inherited;
    const control = controls.get(nodeId);
    const candidates: Scope[] = [];
    if (control?.kind === 'merge') {
      const parent = scopeFor(control.config.parallelNodeId);
      candidates.push(parent.identity, parent.retained);
    } else {
      for (const edge of graph.edges.filter(
        (edge) => edge.target.nodeId === nodeId,
      )) {
        const source = byId.get(edge.source.nodeId);
        if (source === undefined) continue;
        const parent = scopeFor(source.id);
        const sourceControl = controls.get(source.id);
        const scoped =
          configuredScopedOutputPorts({
            ...source,
            ...(sourceControl === undefined ? {} : { control: sourceControl }),
          })?.includes(edge.source.port) ?? false;
        for (const scope of [parent.identity, parent.retained])
          candidates.push(
            scoped
              ? {
                  ...scope,
                  branchPath: [
                    ...scope.branchPath,
                    { nodeId: source.id, outputPort: edge.source.port },
                  ],
                }
              : scope,
          );
      }
    }
    if (candidates.length === 0)
      candidates.push(inherited.identity, inherited.retained);
    const result = {
      identity: candidates.reduce((left, right) =>
        branchKeyBytes(right) > branchKeyBytes(left) ? right : left,
      ),
      retained: candidates.reduce((left, right) =>
        jsonBytes(right) > jsonBytes(left) ? right : left,
      ),
    };
    scopes.set(nodeId, result);
    return result;
  };
  for (const node of graph.nodes) {
    const scopesForNode = scopeFor(node.id);
    let key: string;
    try {
      key = keyFor(node.id, scopesForNode.identity);
    } catch (error) {
      if (!(error instanceof WorkflowEngineError)) throw error;
      refusePersistenceCapacity(
        `$.nodes.${node.id}`,
        `This step's branch or loop scope exceeds the ${String(WORKFLOW_GRAPH_CONTRACT_LIMITS.invocationKeyLength)}-character execution identity limit. Shorten step IDs or reduce nesting.`,
      );
    }
    const scope = scopesForNode.retained;
    const control = controls.get(node.id);
    const handlesFailure = graph.edges.some(
      (edge) =>
        edge.source.nodeId === node.id &&
        edge.source.port === WORKFLOW_FAILURE_PORT,
    );
    const parallel =
      control?.kind === 'merge'
        ? byId.get(control.config.parallelNodeId)
        : undefined;
    const parallelControl =
      parallel === undefined ? undefined : controls.get(parallel.id);
    const branches =
      parallel === undefined
        ? []
        : [
            ...(configuredParallelOutputPorts({
              ...parallel,
              ...(parallelControl === undefined
                ? {}
                : { control: parallelControl }),
            }) ?? []),
          ].sort(compareOrdinal);
    reserveCheckpointNode(checkpoint, node, {
      key,
      scope,
      copies,
      control,
      handlesFailure,
      branches,
      maySuspend: suspendingDefinitions.has(
        `${node.definition.key}@${String(node.definition.version)}`,
      ),
    });
    if (node.structured !== undefined) {
      const { body, maxIterations, maxConcurrency } = node.structured;
      const extend = (parent: Scope): Scope => ({
        ...parent,
        iterationPath: [
          ...parent.iterationPath,
          { loopNodeId: node.id, ordinal: maxIterations - 1 },
        ],
      });
      reserveGraph(
        body,
        {
          identity: extend(scopesForNode.identity),
          retained: extend(scopesForNode.retained),
        },
        {
          ...context,
          copies: copies * Math.min(maxIterations, maxConcurrency),
        },
      );
    }
  }
}

function refusePersistenceCapacity(path: string, message: string): never {
  throw new WorkflowEngineError('executable_invalid', message, {
    cause: new InvalidWorkflowGraphError([
      { code: 'graph_limit', path, message },
    ]),
  });
}
