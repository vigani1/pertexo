import {
  NODE_ATTEMPT_INPUT_LIMITS,
  type NodeAttemptInputs,
  type NodeAttemptLease,
  type NativeNodeAttemptValueSource,
} from '@pertexo/database/execution';

export type NativeNodeAttemptSourceHydrator = (
  input: Readonly<{
    owner: Readonly<{ kind: 'attempt'; lease: NodeAttemptLease }>;
    source: NativeNodeAttemptValueSource;
    signal: AbortSignal;
  }>,
) => Promise<unknown>;

/** Executable grammar owns routing; absence never selects a retained fallback. */
export function assertNativeNodeAttemptInputProjection(
  input: Readonly<{
    inputs: NodeAttemptInputs;
    nativeExecutable: boolean;
    recoveredCallInput: boolean;
  }>,
): void {
  if (input.inputs.nativeValueSources !== undefined && !input.nativeExecutable)
    throw new TypeError(
      'Native input sources require the exact native executable',
    );
  if (
    input.nativeExecutable &&
    input.inputs.nativeValueSources === undefined &&
    !input.recoveredCallInput
  )
    throw new TypeError('Native input source projection is unavailable');
}

/**
 * Framework-only explicit source hydration after control checks, using the
 * heartbeat execution signal. The adapter must independently authorize each
 * accepted source under this consuming lease; descriptors are not authority.
 * Retained decoded JSON passes unchanged and is never scanned for references.
 */
export async function hydrateNativeNodeAttemptInputs(
  input: Readonly<{
    lease: NodeAttemptLease;
    inputs: NodeAttemptInputs;
    signal: AbortSignal;
    hydrate: NativeNodeAttemptSourceHydrator;
    expectedUpstreamNodeOutputs?: readonly Readonly<{
      nodeId: string;
      invocationKey: string;
    }>[];
  }>,
): Promise<NodeAttemptInputs> {
  const sources = input.inputs.nativeValueSources;
  if (sources === undefined || input.inputs.abortRequested) return input.inputs;
  const assertActive = (): void => {
    if (input.signal.aborted)
      throw new DOMException('The operation was aborted', 'AbortError');
  };
  const hydrate = async (
    source: NativeNodeAttemptValueSource,
  ): Promise<unknown> => {
    assertActive();
    const value = await input.hydrate({
      owner: { kind: 'attempt', lease: input.lease },
      source,
      signal: input.signal,
    });
    assertActive();
    return value;
  };
  assertActive();
  const runInputDescriptor: unknown = sources.runInput;
  if (
    runInputDescriptor === undefined ||
    (sources.runInput === null && input.inputs.runInput !== null)
  )
    throw new TypeError('Native run input value source is missing');
  if (
    (input.lease.admissionKind === 'wait_resume') !==
      (sources.resumeOutput !== undefined) ||
    (input.inputs.resumeOutput !== undefined &&
      sources.resumeOutput === undefined)
  )
    throw new TypeError(
      'Native Wait resume value source is missing or unexpected',
    );
  const expected = input.expectedUpstreamNodeOutputs ?? [];
  if (
    sources.completedNodeOutputs.length >
      NODE_ATTEMPT_INPUT_LIMITS.upstreamNodeOutputs ||
    expected.length > NODE_ATTEMPT_INPUT_LIMITS.upstreamNodeOutputs
  )
    throw new TypeError(
      'Native execution value sources exceed the bounded input projection',
    );
  if (
    expected.length !== sources.completedNodeOutputs.length ||
    expected.some((item, index) => {
      const source = sources.completedNodeOutputs[index];
      return (
        source?.source.nodeId !== item.nodeId ||
        source.source.invocationKey !== item.invocationKey
      );
    })
  )
    throw new TypeError(
      'Native upstream value source is missing or out of scope',
    );
  const runInput =
    sources.runInput === null
      ? input.inputs.runInput
      : await hydrate(sources.runInput);
  const completedNodeOutputs = [];
  // One bounded value at a time; no aggregate artifact buffers or Promise.all.
  for (const source of sources.completedNodeOutputs) {
    completedNodeOutputs.push(
      Object.freeze({
        nodeId: source.source.nodeId,
        invocationKey: source.source.invocationKey,
        value: await hydrate(source),
      }),
    );
  }
  const resumeOutput =
    sources.resumeOutput === undefined
      ? input.inputs.resumeOutput
      : await hydrate(sources.resumeOutput);
  return Object.freeze({
    ...input.inputs,
    runInput,
    completedNodeOutputs: Object.freeze(completedNodeOutputs),
    ...(resumeOutput === undefined ? {} : { resumeOutput }),
  });
}
