import type { JsonValue } from '@pertexo/workflow-model';
import type {
  JoinState,
  LoopState,
  IterationScopePart,
} from '../workflow-execution.js';
import type { InlineAttemptSettlement } from '../attempt/inline-settlement.types.js';
import {
  isAgentDefinition,
  WORKFLOW_FAILURE_PORT,
} from '@pertexo/workflow-model';
import { mapPreparedAttemptInput } from '../attempt/execute.js';
import { prepareNodeAttemptInput } from '../attempt/prepare-attempt-input.js';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import {
  deriveForEachUpstreams,
  upstreamInvocationKey,
} from '../attempt/upstream-scope.js';
import { findExecutableNodeContext } from '../compilation/graph.js';
import { executableFailureRoutes } from '../compilation/verified-executable.js';
import { operationError } from '../input-checks/engine-values.js';
import {
  branchPathHasPrefix,
  sameIterationPath,
} from '../invocations/invocation-scope.js';
import type { InvocationState } from '../workflow-execution.js';
import type { InlineAdvanceOptions } from './advance-inline-chain.js';
import type { AdvanceWorkflowInput } from './advance-workflow.js';
import type { MutableWorkflowTransition } from './transition-state.js';

export async function readInlineAttemptInput(
  input: AdvanceWorkflowInput,
  {
    state,
    invocation,
    settled,
    options,
    signal,
  }: Readonly<{
    state: MutableWorkflowTransition;
    invocation: InvocationState;
    settled: readonly InlineAttemptSettlement[];
    options: InlineAdvanceOptions;
    signal: AbortSignal;
  }>,
) {
  const {
    invocationKey,
    nodeId,
    branchPath = [],
    iterationPath = [],
  } = invocation;
  const context = findExecutableNodeContext(
    input.executable.envelope.graph,
    nodeId,
  );
  if (context === undefined)
    operationError(
      'workflow_identity_invalid',
      'inline invocation has no executable node',
    );
  const sources = new Set(
    context.graph.edges.flatMap(({ source, target }) =>
      target.nodeId === nodeId && source.port !== WORKFLOW_FAILURE_PORT
        ? [source.nodeId]
        : [],
    ),
  );
  const upstream = [...sources].map((sourceNodeId) => ({
    nodeId: sourceNodeId,
    invocationKey: upstreamInvocationKey({
      workflowVersionId: input.workflowVersionId,
      sourceNodeId,
      targetNodeId: nodeId,
      edges: context.graph.edges,
      branchPath,
      iterationPath,
    }),
  }));
  const upstreamKeys = upstream.map(({ invocationKey: key }) => key);
  const forEachUpstreams = deriveForEachUpstreams(context.graph, upstream);
  const successes = settled.filter((attempt) => attempt.kind === 'succeeded');
  const local = successes.map((attempt) => ({
    nodeId: attempt.nodeId,
    invocationKey: attempt.invocationKey,
    value: attempt.output,
  }));
  const join = state.joins.get(invocationKey);
  const selected = join?.selectedBranchIds;
  const { scope, loop } = enclosingLoop(state, invocation);
  const attemptIds = [
    ...(loop?.collection.kind === 'inline' ? [loop.collection.attemptId] : []),
    ...(join?.ledger.flatMap(({ branchId, output }) =>
      selected?.includes(branchId) && output?.kind === 'inline'
        ? [output.attemptId]
        : [],
    ) ?? []),
  ];
  const route = executableFailureRoutes(input.executable).find(
    ({ entryNodeId }) => entryNodeId === nodeId,
  );
  const failureSource =
    route === undefined
      ? undefined
      : context.graph.nodes.find(({ id }) => id === route.sourceNodeId);
  const agentFailureSourceNodeId =
    failureSource !== undefined && isAgentDefinition(failureSource.definition)
      ? failureSource.id
      : undefined;
  const localFailure = state.failureValues.find(
    ({ entryInvocationKey }) => entryInvocationKey === invocationKey,
  )?.value;
  const persisted = await options.readValues({
    invocationKeys: upstreamKeys.filter(
      (key) => !local.some((item) => item.invocationKey === key),
    ),
    iterationPath,
    ...(forEachUpstreams.length === 0 ? {} : { forEachUpstreams }),
    attemptIds: attemptIds.filter(
      (id) => !successes.some((attempt) => attempt.attemptId === id),
    ),
    ...(route === undefined || localFailure !== undefined
      ? {}
      : { failureEntryKey: invocationKey }),
    ...(agentFailureSourceNodeId === undefined
      ? {}
      : { agentFailureSourceNodeId }),
  });
  if (persisted.loopResultsTooLarge)
    throw new NodeExecutorFailure({
      kind: 'failed',
      errorKind: 'configuration',
      possiblyDispatched: false,
      safeErrorCode: 'execution.loop_results_too_large',
    });
  const outputs = new Map([
    ...persisted.attemptOutputs.map(
      ({ attemptId, value }) => [attemptId, value] as const,
    ),
    ...successes.map(({ attemptId, output }) => [attemptId, output] as const),
  ]);
  const coordinatorInput = mergeInput(join, outputs);
  const prepared = prepareNodeAttemptInput(
    {
      executable: input.executable,
      workflowVersionId: input.workflowVersionId,
      nodeId,
      invocationKey,
      branchPath,
      iterationPath,
      runInput: persisted.runInput,
      ...(persisted.variables === undefined
        ? {}
        : { variables: persisted.variables }),
      completedNodeOutputs: [
        ...persisted.outputs,
        ...local.filter(({ invocationKey: key }) => upstreamKeys.includes(key)),
      ],
      sourceFailure: localFailure ?? persisted.sourceFailure,
      ...structuredInputProof(loop, scope, outputs),
      signal,
    },
    persisted.agentFailureSourceLabel,
  );
  return mapPreparedAttemptInput(
    {
      signal,
      ...(options.expressionEvaluator === undefined
        ? {}
        : { expressionEvaluator: options.expressionEvaluator }),
      coordinatorInput,
    },
    prepared,
  );
}

function mergeInput(
  join: JoinState | undefined,
  outputs: ReadonlyMap<string, JsonValue>,
) {
  const selected = join?.selectedBranchIds;
  return join === undefined || selected === undefined
    ? undefined
    : {
        selectedBranchIds: selected,
        ledger: Object.fromEntries(
          join.ledger.map(
            ({
              branchId,
              disposition,
              output,
            }): readonly [
              string,
              Readonly<{ disposition: typeof disposition; output?: unknown }>,
            ] => {
              if (selected.includes(branchId) && output?.kind === 'inline') {
                const value = outputs.get(output.attemptId);
                if (value === undefined)
                  operationError(
                    'attempt_invalid',
                    'settled Merge output is missing',
                  );
                return [branchId, { disposition, output: value }] as const;
              }
              return [
                branchId,
                { disposition, ...(output === undefined ? {} : { output }) },
              ] as const;
            },
          ),
        ),
      };
}

function enclosingLoop(
  state: MutableWorkflowTransition,
  { branchPath = [], iterationPath = [] }: InvocationState,
) {
  const scope = iterationPath.at(-1);
  const loop =
    scope === undefined
      ? undefined
      : [...state.loops.values()].find(
          (candidate) =>
            candidate.loopId === scope.loopNodeId &&
            sameIterationPath(
              candidate.iterationPath,
              iterationPath.slice(0, -1),
            ) &&
            branchPathHasPrefix(branchPath, candidate.branchPath),
        );
  return { scope, loop };
}

function structuredInputProof(
  loop: LoopState | undefined,
  scope: IterationScopePart | undefined,
  outputs: ReadonlyMap<string, JsonValue>,
) {
  if (loop === undefined || scope === undefined) return {};
  const collection =
    loop.collection.kind === 'inline'
      ? outputs.get(loop.collection.attemptId)
      : undefined;
  return {
    structuredCollection: {
      loopNodeId: loop.loopId,
      ordinal: scope.ordinal,
      collection: (collection as { items?: unknown } | undefined)?.items,
      collectionSize: loop.collectionSize,
      declaredCollectionChecksum: loop.collectionChecksum,
    },
  };
}
