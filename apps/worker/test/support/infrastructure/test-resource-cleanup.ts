import type { TestContext } from 'vitest';

/** Join normal teardown and Vitest's teardown after a timed-out test body. */
export function registerTestResourceCleanup(
  context: Pick<TestContext, 'onTestFinished'>,
  operation: () => Promise<void>,
): () => Promise<void> {
  let cleanup: Promise<void> | undefined;
  const close = () => (cleanup ??= operation());
  context.onTestFinished(close, 30_000);
  return close;
}
