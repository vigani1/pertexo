export type OwnedNodeAttemptResource = Readonly<{
  close: () => Promise<unknown>;
  name: string;
  phase: 'drain' | 'release';
}>;

export function assertNodeAttemptRuntimeOpen(lifecycle: {
  terminal: boolean;
}): void {
  if (lifecycle.terminal) throw new Error('Node-attempt runtime is closed');
}

export async function closeNodeAttemptResources(
  resources: readonly OwnedNodeAttemptResource[],
  primary?: Readonly<{ error: unknown }>,
): Promise<void> {
  const drainSettled = await Promise.allSettled(
    resources
      .filter(({ phase }) => phase === 'drain')
      .map(({ close }) => Promise.resolve().then(close)),
  );
  const releaseSettled = await Promise.allSettled(
    resources
      .filter(({ phase }) => phase === 'release')
      .map(({ close }) => Promise.resolve().then(close)),
  );
  const cleanupFailures: unknown[] = [];
  for (const result of [...drainSettled, ...releaseSettled])
    if (result.status === 'rejected')
      cleanupFailures.push(result.reason as unknown);
  const failures: unknown[] = [
    ...(primary === undefined ? [] : [primary.error]),
    ...cleanupFailures,
  ];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      primary === undefined
        ? 'Node-attempt runtime cleanup failed'
        : 'Node-attempt runtime construction failed and cleanup was incomplete',
    );
}

export type OwnNodeAttemptResource = (
  name: string,
  close: (() => Promise<unknown>) | undefined,
) => void;
