import {
  NodeAttemptStateCorruptError,
  type NodeAttemptRunStore,
  type NodeAttemptStoredInputs,
} from '@pertexo/database/attempts';
import {
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

/** The active loop instance the attempt's innermost iteration belongs to. */
function innermostLoop(
  checkpoint: WorkflowCheckpoint,
  iterationPath: readonly IterationScopePart[],
  branchPath: readonly BranchScopePart[],
): Readonly<{ loop: LoopState; scope: IterationScopePart }> | undefined {
  const scope = iterationPath.at(-1);
  if (scope === undefined) return undefined;
  const enclosing = canonicalJson(iterationPath.slice(0, -1));
  const loop = checkpoint.loops.find(
    (candidate) =>
      candidate.loopId === scope.loopNodeId &&
      canonicalJson(candidate.iterationPath) === enclosing &&
      candidate.branchPath.every(
        (part, index) =>
          branchPath[index]?.nodeId === part.nodeId &&
          branchPath[index].outputPort === part.outputPort,
      ) &&
      candidate.activeOrdinals.includes(scope.ordinal),
  );
  if (loop === undefined) throw new NodeAttemptStateCorruptError();
  return { loop, scope };
}

/**
 * Reads what a claimed attempt's executor needs: stored values from the
 * database, and the join input and loop item projected from the checkpoint.
 * The engine verifies the loop item against the declared checksum.
 */
export async function loadAttemptInputs(
  store: Pick<NodeAttemptRunStore, 'loadInputs' | 'readLoopDeclaration'>,
  input: LoadInputsRequest,
): Promise<NodeAttemptInputs> {
  const { checkpoint: stored, ...inputs } = await store.loadInputs(input);
  const checkpoint = parseCheckpoint(stored);
  const join = coordinatorInput(checkpoint, input.lease.invocationKey);
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
  });
}
