type Closable = Readonly<{ close(): Promise<void> }>;
type Phase =
  | 'dispatcher'
  | 'producer'
  | 'dispatcher-database'
  | 'attempts'
  | 'coordinator'
  | 'redis-namespace';

export class EditorBrowserWorkerShutdownError extends AggregateError {
  constructor(
    readonly phases: readonly Phase[],
    errors: readonly unknown[],
  ) {
    super(errors, 'Editor browser worker shutdown failed');
  }
}

/** Owns the pure-node fixture's dependency order and retained-lease rule. */
export async function closeEditorBrowserWorker(
  resources: Readonly<{
    dispatcher?: Closable | undefined;
    producer?: Closable | undefined;
    dispatcherDatabase?: Closable | undefined;
    attempts?: Closable | undefined;
    coordinator?: Closable | undefined;
    namespace: Closable;
  }>,
): Promise<void> {
  const failures: { phase: Phase; error: unknown }[] = [];
  const owned: readonly (readonly [Phase, Closable | undefined])[] = [
    ['dispatcher', resources.dispatcher],
    [
      'producer',
      resources.dispatcher === undefined ? resources.producer : undefined,
    ],
    [
      'dispatcher-database',
      resources.dispatcher === undefined
        ? resources.dispatcherDatabase
        : undefined,
    ],
    ['attempts', resources.attempts],
    ['coordinator', resources.coordinator],
  ];
  for (const [phase, resource] of owned) {
    try {
      await resource?.close();
    } catch (error) {
      failures.push({ phase, error });
    }
  }
  if (failures.length > 0)
    throw new EditorBrowserWorkerShutdownError(
      failures.map(({ phase }) => phase),
      failures.map(({ error }) => error),
    );
  try {
    await resources.namespace.close();
  } catch (error) {
    throw new EditorBrowserWorkerShutdownError(['redis-namespace'], [error]);
  }
}
