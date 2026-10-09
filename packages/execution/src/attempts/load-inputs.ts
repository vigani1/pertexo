import { createHash } from 'node:crypto';

import {
  NodeAttemptStateCorruptError,
  type NodeAttemptLease,
  type NodeAttemptLoopDeclaration,
  type NodeAttemptRunStore,
  type NodeAttemptStoredInputs,
} from '@pertexo/database/attempts';
import {
  invocationKey,
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
  }>;

type LoadInputsRequest = Parameters<NodeAttemptRunStore['loadInputs']>[0];

function scopedKey(
  lease: NodeAttemptLease,
  nodeId: string,
  branchPath: readonly BranchScopePart[],
): string {
  return invocationKey({
    workflowVersionId: lease.workflowVersionId,
    nodeId,
    branchPath: branchPath.map((part) => `${part.nodeId}:${part.outputPort}`),
    ...(lease.iterationPath === undefined
      ? {}
      : { iterationPath: lease.iterationPath }),
  });
}

/** An attempt may read only outputs from its own branch and loop scope. */
function assertUpstreamInScope(input: LoadInputsRequest): void {
  const branchPath = input.lease.branchPath ?? [];
  const nearestBranch = branchPath.at(-1);
  for (const { nodeId, invocationKey: key } of input.upstreamNodeOutputs) {
    const candidates = [branchPath];
    if (nearestBranch?.nodeId === nodeId)
      candidates.push(branchPath.slice(0, -1));
    if (
      !candidates.some((path) => key === scopedKey(input.lease, nodeId, path))
    )
      throw new NodeAttemptStateCorruptError();
  }
}

function coordinatorInput(
  checkpoint: WorkflowCheckpoint,
  key: string,
): NodeAttemptInputs['coordinatorInput'] {
  const join = checkpoint.joins.find(
    ({ joinInvocationKey }) => joinInvocationKey === key,
  );
  if (join?.selectedBranchIds === undefined) return undefined;
  return Object.freeze({
    ledger: Object.fromEntries(
      join.ledger.map(({ branchId, disposition, output }) => [
        branchId,
        { disposition, ...(output === undefined ? {} : { output }) },
      ]),
    ),
    selectedBranchIds: join.selectedBranchIds,
  });
}

/** The active loop for each level of the attempt's iteration path. */
function enclosingLoops(
  checkpoint: WorkflowCheckpoint,
  iterationPath: readonly IterationScopePart[],
  branchPath: readonly BranchScopePart[],
): readonly LoopState[] {
  return iterationPath.map((scope, index) => {
    const enclosing = canonicalJson(iterationPath.slice(0, index));
    const matches = checkpoint.loops.filter(
      (loop) =>
        loop.loopId === scope.loopNodeId &&
        canonicalJson(loop.iterationPath) === enclosing &&
        loop.branchPath.length <= branchPath.length &&
        loop.branchPath.every(
          (part, branchIndex) =>
            branchPath[branchIndex]?.nodeId === part.nodeId &&
            branchPath[branchIndex].outputPort === part.outputPort,
        ) &&
        loop.activeOrdinals.includes(scope.ordinal),
    );
    const [loop] = matches;
    if (matches.length !== 1 || loop === undefined)
      throw new NodeAttemptStateCorruptError();
    return loop;
  });
}

/** The item for `scope` from the collection the loop was declared with. */
function loopItem(
  loop: LoopState,
  scope: IterationScopePart,
  declaration: NodeAttemptLoopDeclaration | undefined,
): NonNullable<NodeAttemptInputs['structuredCollection']> {
  const output = declaration?.output;
  if (
    declaration?.nodeId !== loop.loopId ||
    loop.collection.kind !== 'inline' ||
    loop.collection.attemptId !== declaration.attemptId ||
    output === null ||
    typeof output !== 'object' ||
    Array.isArray(output)
  )
    throw new NodeAttemptStateCorruptError();
  const { items, iterationCount, ...rest } = output as Readonly<
    Record<string, unknown>
  >;
  if (
    Object.keys(rest).length > 0 ||
    !Array.isArray(items) ||
    iterationCount !== items.length ||
    loop.collectionSize !== items.length ||
    scope.ordinal < 0 ||
    scope.ordinal >= items.length ||
    loop.collectionChecksum !==
      createHash('sha256').update(canonicalJson(items)).digest('hex')
  )
    throw new NodeAttemptStateCorruptError();
  return Object.freeze({
    loopNodeId: loop.loopId,
    ordinal: scope.ordinal,
    collection: items,
    collectionSize: loop.collectionSize,
    declaredCollectionChecksum: loop.collectionChecksum,
  });
}

/**
 * Reads what a claimed attempt's executor needs: stored values from the
 * database, and the join input and loop item projected from the checkpoint.
 */
export async function loadAttemptInputs(
  store: Pick<NodeAttemptRunStore, 'loadInputs' | 'readLoopDeclaration'>,
  input: LoadInputsRequest,
): Promise<NodeAttemptInputs> {
  assertUpstreamInScope(input);
  const { checkpoint: stored, ...inputs } = await store.loadInputs(input);
  const checkpoint = parseCheckpoint(stored);
  const join = coordinatorInput(checkpoint, input.lease.invocationKey);
  const iterationPath = input.lease.iterationPath ?? [];
  let structuredCollection: NodeAttemptInputs['structuredCollection'];
  const scope = iterationPath.at(-1);
  if (scope !== undefined) {
    const loop = enclosingLoops(
      checkpoint,
      iterationPath,
      input.lease.branchPath ?? [],
    ).at(-1);
    if (loop === undefined) throw new NodeAttemptStateCorruptError();
    structuredCollection = loopItem(
      loop,
      scope,
      await store.readLoopDeclaration({
        lease: input.lease,
        controlInvocationKey: loop.controlInvocationKey,
        signal: input.signal,
      }),
    );
  }
  return Object.freeze({
    ...inputs,
    ...(join === undefined ? {} : { coordinatorInput: join }),
    ...(structuredCollection === undefined ? {} : { structuredCollection }),
  });
}
