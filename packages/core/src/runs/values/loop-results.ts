import type { ForEachUpstream } from '../load-attempt-inputs.js';
import type {
  NodeAttemptStoredInputs,
  NodeRunOutcome,
  NodeRunStoredOutput,
} from '../../attempts/node-attempt.js';
import { NodeAttemptStateCorruptError } from '../../attempts/node-attempt.errors.js';
import type { IterationScopePart } from '@pertexo/workflow-engine';
import { loopIterationOrdinal } from '@pertexo/workflow-engine/server';

type CompletedOutput = NodeAttemptStoredInputs['completedNodeOutputs'][number];

/**
 * What a finished loop passes on: its output plus `results`, each pass's
 * result in item order, null for a pass that skipped the body's last step.
 * The checkpoint releases passes as they settle, so results are read back
 * from the stored step runs.
 */
export async function withLoopResults({
  readOutcomes,
  readOutputs,
  iterationPath,
  output,
  loop,
  maxBytes,
}: Readonly<{
  readOutcomes: (nodeId: string) => Promise<readonly NodeRunOutcome[]>;
  readOutputs: (
    keys: readonly string[],
  ) => Promise<readonly NodeRunStoredOutput[]>;
  iterationPath: readonly IterationScopePart[];
  output: CompletedOutput;
  loop: ForEachUpstream;
  maxBytes: number;
}>): Promise<CompletedOutput | undefined> {
  const count = (output.value as { iterationCount?: unknown } | null)
    ?.iterationCount;
  if (typeof count !== 'number') throw new NodeAttemptStateCorruptError();
  const passes = new Map<number, { invocationKey: string; bytes?: number }>();
  for (const outcome of await readOutcomes(loop.sinkNodeId)) {
    const ordinal = loopIterationOrdinal(
      outcome.invocationKey,
      loop.nodeId,
      iterationPath,
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
      await readOutputs(succeeded.map(({ invocationKey }) => invocationKey))
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
