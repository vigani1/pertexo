export function createTransportTestCleanupStack(stage: string) {
  const owners: { close: () => unknown; label: string }[] = [];
  let closed = false;
  return Object.freeze({
    add(label: string, close: () => unknown): () => Promise<void> {
      if (closed)
        throw new Error(`Cannot register ${label} after ${stage} cleanup`);
      let closePromise: Promise<void> | undefined;
      const closeOnce = (): Promise<void> => {
        closePromise ??= Promise.resolve()
          .then(close)
          .then(() => undefined);
        return closePromise;
      };
      owners.push({ close: closeOnce, label });
      return closeOnce;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      for (const owner of owners.reverse())
        await Promise.resolve()
          .then(owner.close)
          .catch((cause: unknown) => {
            errors.push(
              new Error(`${stage} cleanup failed: ${owner.label}`, { cause }),
            );
          });
      if (errors.length > 0)
        throw new AggregateError(errors, `${stage} cleanup failed`);
    },
  });
}
