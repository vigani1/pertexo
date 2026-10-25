import {
  NodeAttemptStateCorruptError,
  type NodeAttemptRunStore,
  type NodeAttemptStoredInputs,
} from '@pertexo/database/attempts';
import {
  loopIterationOrdinal,
  NODE_ATTEMPT_INPUT_LIMITS,
  parseCheckpoint,
  type BranchScopePart,
  type IterationScopePart,
  type LoopState,
  type WorkflowCheckpoint,
} from '@pertexo/workflow-engine';
import { canonicalJson } from '@pertexo/workflow-model';

/** Everything a node attempt's executor reads, projected from stored state. */
export type NodeAttemptInputs = Omit<NodeAttemptStoredInputs, 'checkpoint'> &
  Readonly<{
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

type LoadInputsRequest = Parameters<NodeAttemptRunStore['loadInputs']>[0];

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

type CompletedOutput = NodeAttemptStoredInputs['completedNodeOutputs'][number];

/**
 * What a finished loop passes on: its output plus `results`, each pass's
 * result in item order, null for a pass that skipped the body's last step.
 * The checkpoint releases passes as they settle, so results are read back
 * from the stored step runs.
 */
async function withLoopResults({
  store,
  request,
  output,
  loop,
  maxBytes,
}: Readonly<{
  store: Pick<NodeAttemptRunStore, 'listNodeOutcomes' | 'readNodeOutputs'>;
  request: LoadInputsRequest;
  output: CompletedOutput;
  loop: ForEachUpstream;
  maxBytes: number;
}>): Promise<CompletedOutput | undefined> {
  const count = (output.value as { iterationCount?: unknown } | null)
    ?.iterationCount;
  if (typeof count !== 'number') throw new NodeAttemptStateCorruptError();
  const passes = new Map<number, { invocationKey: string; bytes?: number }>();
  for (const outcome of await store.listNodeOutcomes({
    lease: request.lease,
    nodeId: loop.sinkNodeId,
    signal: request.signal,
  })) {
    const ordinal = loopIterationOrdinal(
      outcome.invocationKey,
      loop.nodeId,
      request.lease.iterationPath ?? [],
    );
    if (ordinal === undefined) continue;
    if (ordinal >= count || passes.has(ordinal))
      throw new NodeAttemptStateCorruptError();
    passes.set(ordinal, {
      invocationKey: outcome.invocationKey,
      ...(outcome.status === 'succeeded' ? { bytes: outcome.outputBytes } : {}),
    });
  }
  const succeeded = [...passes.values()].filter(
    (pass) => pass.bytes !== undefined,
  );
  if (succeeded.reduce((sum, pass) => sum + (pass.bytes ?? 0), 0) > maxBytes)
    return undefined;
  const stored = new Map(
    (
      await store.readNodeOutputs({
        lease: request.lease,
        invocationKeys: succeeded.map(({ invocationKey }) => invocationKey),
        signal: request.signal,
      })
    ).map(({ invocationKey, output: value }) => [invocationKey, value]),
  );
  const results = Array.from({ length: count }, (_, ordinal) => {
    const pass = passes.get(ordinal);
    return pass?.bytes === undefined ? null : stored.get(pass.invocationKey);
  });
  return Object.freeze({
    ...output,
    value: { ...(output.value as object), results },
  });
}

/**
 * A Merge's settled branches with each selected branch's result: the
 * checkpoint keeps a reference to the branch's attempt, and its stored output
 * is what the Merge passes on.
 */
async function coordinatorInput(
  store: Pick<NodeAttemptRunStore, 'readAttemptOutputs'>,
  request: LoadInputsRequest,
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

function assertUpstreamInputs(input: LoadInputsRequest): void {
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
  input: LoadInputsRequest,
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
        store,
        request: input,
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
  const checkpoint = parseCheckpoint(stored);
  if (inputs.sourceFailure !== undefined) {
    const source = checkpoint.invocations.find(
      ({ invocationKey }) =>
        invocationKey === inputs.sourceFailure?.invocationKey,
    );
    const handler = checkpoint.invocations.find(
      ({ invocationKey }) => invocationKey === input.lease.invocationKey,
    );
    const sourceFailureStateInvalid =
      source?.status !== 'failed' ||
      source.failureHandling?.disposition !== 'pending' ||
      source.attemptNumber !== inputs.sourceFailure.attemptNumber ||
      handler?.status !== 'running' ||
      handler.attemptNumber !== input.lease.attemptNumber;
    if (sourceFailureStateInvalid) throw new NodeAttemptStateCorruptError();
  }
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
    ...(join === undefined ? {} : { coordinatorInput: join }),
    ...(structuredCollection === undefined ? {} : { structuredCollection }),
    ...(loopResultsTooLarge ? { loopResultsTooLarge: true as const } : {}),
  });
}
