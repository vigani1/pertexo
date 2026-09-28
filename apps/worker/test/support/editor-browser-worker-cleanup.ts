type Closable = Readonly<{ close(): Promise<void> }>;
type Phase =
  | 'dispatcher'
  | 'producer'
  | 'dispatcher-database'
  | 'attempts'
  | 'coordinator'
  | 'triggers'
  | 'capabilities'
  | 'controlled-http'
  | 'envelope-keys'
  | 'startup'
  | 'restart'
  | 'redis-namespace';

export type EditorBrowserWorkerRuntimes = Readonly<{
  dispatcher?: Closable | undefined;
  producer?: Closable | undefined;
  dispatcherDatabase?: Closable | undefined;
  triggers?: readonly Closable[] | undefined;
  attempts?: Closable | undefined;
  coordinator?: Closable | undefined;
  capabilities?: Closable | undefined;
  controlledHttp?: Closable | undefined;
  envelopeKeys?: Closable | undefined;
}>;

export class EditorBrowserWorkerShutdownError extends AggregateError {
  constructor(
    readonly phases: readonly Phase[],
    errors: readonly unknown[],
  ) {
    super(errors, 'Editor browser worker shutdown failed');
  }
}

/** Owns the pure-node fixture's dependency order and retained-lease rule. */
export async function closeEditorBrowserWorkerRuntimes(
  resources: EditorBrowserWorkerRuntimes,
): Promise<void> {
  const failures: { phase: Phase; error: unknown }[] = [];
  let attemptsDrained = resources.attempts === undefined;
  const owned: readonly (readonly [Phase, Closable | undefined])[] = [
    ['dispatcher', resources.dispatcher],
    [
      'producer',
      resources.dispatcher === undefined ? resources.producer : undefined,
    ],
    ...(resources.triggers ?? []).map(
      (runtime) => ['triggers', runtime] as const,
    ),
    [
      'dispatcher-database',
      resources.dispatcher === undefined
        ? resources.dispatcherDatabase
        : undefined,
    ],
    ['attempts', resources.attempts],
    ['coordinator', resources.coordinator],
    ['capabilities', resources.capabilities],
    ['controlled-http', resources.controlledHttp],
    ['envelope-keys', resources.envelopeKeys],
  ];
  for (const [phase, resource] of owned) {
    if (
      !attemptsDrained &&
      ['capabilities', 'controlled-http', 'envelope-keys'].includes(phase)
    )
      continue;
    try {
      await resource?.close();
      if (phase === 'attempts') attemptsDrained = true;
    } catch (error) {
      failures.push({ phase, error });
    }
  }
  if (failures.length > 0)
    throw new EditorBrowserWorkerShutdownError(
      failures.map(({ phase }) => phase),
      failures.map(({ error }) => error),
    );
}

export async function closeEditorBrowserWorker(
  resources: EditorBrowserWorkerRuntimes & Readonly<{ namespace: Closable }>,
): Promise<void> {
  await closeEditorBrowserWorkerRuntimes(resources);
  try {
    await resources.namespace.close();
  } catch (error) {
    throw new EditorBrowserWorkerShutdownError(['redis-namespace'], [error]);
  }
}
