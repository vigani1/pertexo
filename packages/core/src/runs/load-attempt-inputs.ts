import { decodeStoredValue } from '../shared/stored-values.js';
import type {
  LoadInputsInput,
  NodeAttemptRunStore,
  NodeAttemptStoredInputs,
} from '../attempts/node-attempt.js';
import { NodeAttemptStateCorruptError } from '../attempts/node-attempt.errors.js';
import {
  NODE_ATTEMPT_INPUT_LIMITS,
  type BranchScopePart,
  type IterationScopePart,
  type LoopState,
  type WorkflowCheckpoint,
} from '@pertexo/workflow-engine';
import { parseCheckpoint } from '@pertexo/workflow-engine/server';
import { withLoopResults } from './values/loop-results.js';
import { canonicalJson } from '@pertexo/workflow-model';
import { loadAgentAttemptInput } from './agent-attempt-input.js';
import type { AgentAttemptInput } from '@pertexo/workflow-engine/server';

/** Everything a node attempt's executor reads, projected from stored state. */
export type NodeAttemptInputs = Omit<NodeAttemptStoredInputs, 'checkpoint'> &
  Readonly<{
    agent?: AgentAttemptInput;
    /** A join's selected branches and their outputs. */
    coordinatorInput?: Readonly<{
      ledger: Readonly<Record<string, unknown>>;
      selectedBranchIds: readonly string[];
    }>;
    /** The For Each item this attempt runs for. */
    structuredCollection?: Readonly<{
      loopNodeId: string;
      ordinal: number;
      collection: unknown;
      collectionSize: number;
      declaredCollectionChecksum: string;
    }>;
    /** A finished loop's results were too large to pass on. */
    loopResultsTooLarge?: true;
  }>;

/** A finished For Each step that feeds the attempt, and its body's last step. */
export type ForEachUpstream = Readonly<{
  nodeId: string;
  invocationKey: string;
  sinkNodeId: string;
}>;

export type LoopResultsRequest = Readonly<{
  loops: readonly ForEachUpstream[];
  maxBytes: number;
}>;

/**
 * A Merge's settled branches with each selected branch's result: the
 * checkpoint keeps a reference to the branch's attempt, and its stored output
 * is what the Merge passes on.
 */
async function coordinatorInput(
  store: Pick<NodeAttemptRunStore, 'readAttemptOutputs'>,
  request: LoadInputsInput,
  checkpoint: WorkflowCheckpoint,
): Promise<NodeAttemptInputs['coordinatorInput']> {
  const join = checkpoint.joins.find(
    ({ joinInvocationKey }) =>
      joinInvocationKey === request.lease.invocationKey,
  );
  const selected = join?.selectedBranchIds;
  if (join === undefined || selected === undefined) return undefined;
  const attemptIds = join.ledger.flatMap(({ branchId, output }) =>
    selected.includes(branchId) && output?.kind === 'inline'
      ? [output.attemptId]
      : [],
  );
  const outputs = new Map(
    (
      await store.readAttemptOutputs({
        lease: request.lease,
        attemptIds,
        signal: request.signal,
      })
    ).map(({ attemptId, output }) => [attemptId, output]),
  );
  return Object.freeze({
    ledger: Object.fromEntries(
      join.ledger.map(({ branchId, disposition, output }) => {
        if (output === undefined) return [branchId, { disposition }];
        if (!selected.includes(branchId) || output.kind !== 'inline')
          return [branchId, { disposition, output }];
        if (!outputs.has(output.attemptId))
          throw new NodeAttemptStateCorruptError();
        return [
          branchId,
          { disposition, output: outputs.get(output.attemptId) },
        ];
      }),
    ),
    selectedBranchIds: selected,
  });
}

/** The active loop instance the attempt's innermost iteration belongs to. */
function innermostLoop(
  checkpoint: WorkflowCheckpoint,
  iterationPath: readonly IterationScopePart[],
  branchPath: readonly BranchScopePart[],
): Readonly<{ loop: LoopState; scope: IterationScopePart }> | undefined {
  const scope = iterationPath.at(-1);
  if (scope === undefined) return undefined;
  const enclosing = canonicalJson(iterationPath.slice(0, -1));
  const loop = checkpoint.loops.find((candidate) => {
    const matchesLoop =
      candidate.loopId === scope.loopNodeId &&
      canonicalJson(candidate.iterationPath) === enclosing &&
      candidate.branchPath.every(
        (part, index) =>
          branchPath[index]?.nodeId === part.nodeId &&
          branchPath[index].outputPort === part.outputPort,
      ) &&
      candidate.activeOrdinals.includes(scope.ordinal);
    return matchesLoop;
  });
  if (loop === undefined) throw new NodeAttemptStateCorruptError();
  return { loop, scope };
}

function assertUpstreamInputs(input: LoadInputsInput): void {
  if (
    input.upstreamNodeOutputs.length >
      NODE_ATTEMPT_INPUT_LIMITS.upstreamNodeOutputs ||
    new Set(input.upstreamNodeOutputs.map(({ invocationKey }) => invocationKey))
      .size !== input.upstreamNodeOutputs.length
  )
    throw new NodeAttemptStateCorruptError();
}

/**
 * Reads what a claimed attempt's executor needs: stored values from the
 * database, and the join input and loop item projected from the checkpoint.
 * The engine verifies the loop item against the declared checksum.
 */
export async function loadAttemptInputs(
  store: Pick<
    NodeAttemptRunStore,
    | 'loadInputs'
    | 'readLoopDeclaration'
    | 'readAttemptOutputs'
    | 'listNodeOutcomes'
    | 'readNodeOutputs'
  >,
  input: LoadInputsInput,
  loopResults?: LoopResultsRequest,
): Promise<NodeAttemptInputs> {
  assertUpstreamInputs(input);
  const { checkpoint: stored, ...loaded } = await store.loadInputs(input);
  const resolved = await Promise.all(
    loaded.completedNodeOutputs.map(async (output) => {
      const loop = loopResults?.loops.find(
        ({ invocationKey }) => invocationKey === output.invocationKey,
      );
      if (loop === undefined) return { output, tooLarge: false };
      const withResults = await withLoopResults({
        readOutcomes: (nodeId) =>
          store.listNodeOutcomes({
            lease: input.lease,
            nodeId,
            signal: input.signal,
          }),
        readOutputs: (invocationKeys) =>
          store.readNodeOutputs({
            lease: input.lease,
            invocationKeys,
            signal: input.signal,
          }),
        iterationPath: input.lease.iterationPath ?? [],
        output,
        loop,
        maxBytes: loopResults?.maxBytes ?? 0,
      });
      return {
        output: withResults ?? output,
        tooLarge: withResults === undefined,
      };
    }),
  );
  const loopResultsTooLarge = resolved.some(({ tooLarge }) => tooLarge);
  const inputs = {
    ...loaded,
    completedNodeOutputs: resolved.map(({ output }) => output),
  };
  const checkpoint = decodeStoredValue(() => parseCheckpoint(stored));
  const agent = await loadAgentAttemptInput(store, {
    request: input,
    checkpoint,
    runDeadlineAt: inputs.deadlineAt,
  });
  verifySourceFailure(checkpoint, input, inputs.sourceFailure);
  const join = await coordinatorInput(store, input, checkpoint);
  const innermost = innermostLoop(
    checkpoint,
    input.lease.iterationPath ?? [],
    input.lease.branchPath ?? [],
  );
  let structuredCollection: NodeAttemptInputs['structuredCollection'];
  if (innermost !== undefined) {
    const { loop, scope } = innermost;
    const declaration = await store.readLoopDeclaration({
      lease: input.lease,
      controlInvocationKey: loop.controlInvocationKey,
      signal: input.signal,
    });
    const items = (declaration?.output as { items?: unknown } | null)?.items;
    if (loop.collection.kind !== 'inline' || !Array.isArray(items))
      throw new NodeAttemptStateCorruptError();
    structuredCollection = Object.freeze({
      loopNodeId: loop.loopId,
      ordinal: scope.ordinal,
      collection: items,
      collectionSize: loop.collectionSize,
      declaredCollectionChecksum: loop.collectionChecksum,
    });
  }
  return Object.freeze({
    ...inputs,
    ...agent,
    ...(join === undefined ? {} : { coordinatorInput: join }),
    ...(structuredCollection === undefined ? {} : { structuredCollection }),
    ...(loopResultsTooLarge ? { loopResultsTooLarge: true as const } : {}),
  });
}

function verifySourceFailure(
  checkpoint: WorkflowCheckpoint,
  input: LoadInputsInput,
  failure: NodeAttemptStoredInputs['sourceFailure'],
): void {
  if (failure === undefined) return;

  const source = checkpoint.invocations.find(
    ({ invocationKey }) => invocationKey === failure.invocationKey,
  );
  const handler = checkpoint.invocations.find(
    ({ invocationKey }) => invocationKey === input.lease.invocationKey,
  );
  const sourceFailureStateInvalid =
    source?.status !== 'failed' ||
    source.failureHandling?.disposition !== 'pending' ||
    (source.agentWork?.parentInvocationKey ?? source.invocationKey) !==
      input.sourceFailure?.invocationKey ||
    source.attemptNumber !== failure.attemptNumber ||
    handler?.status !== 'running' ||
    handler.attemptNumber !== input.lease.attemptNumber;
  if (sourceFailureStateInvalid) throw new NodeAttemptStateCorruptError();
}
