import type { JoinState } from '../workflow-execution.js';

export function selectMergeInput(join: JoinState | undefined) {
  const selectedBranchIds = join?.selectedBranchIds;
  if (join === undefined || selectedBranchIds === undefined) return undefined;
  const attemptIds = join.ledger.flatMap((entry) => {
    const attemptId = selectedInlineAttempt(entry, selectedBranchIds);
    return attemptId === undefined ? [] : [attemptId];
  });
  return { ledger: join.ledger, selectedBranchIds, attemptIds };
}

export function projectMergeInput(
  {
    ledger,
    selectedBranchIds,
  }: NonNullable<ReturnType<typeof selectMergeInput>>,
  outputs: ReadonlyMap<string, unknown>,
) {
  const entries: [
    string,
    {
      disposition: JoinState['ledger'][number]['disposition'];
      output?: unknown;
    },
  ][] = [];
  for (const entry of ledger) {
    const { branchId, disposition, output } = entry;
    const attemptId = selectedInlineAttempt(entry, selectedBranchIds);
    if (attemptId !== undefined && !outputs.has(attemptId))
      return { kind: 'missing_output' as const };
    entries.push([
      branchId,
      attemptId !== undefined
        ? { disposition, output: outputs.get(attemptId) }
        : { disposition, ...(output === undefined ? {} : { output }) },
    ]);
  }
  return {
    kind: 'projected' as const,
    input: Object.freeze({
      ledger: Object.fromEntries(entries),
      selectedBranchIds,
    }),
  };
}

function selectedInlineAttempt(
  { branchId, output }: JoinState['ledger'][number],
  selectedBranchIds: readonly string[],
): string | undefined {
  return output?.kind === 'inline' && selectedBranchIds.includes(branchId)
    ? output.attemptId
    : undefined;
}
