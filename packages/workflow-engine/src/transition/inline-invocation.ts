import { testStepDisposition } from '../testing/policy.js';
import { selectReadyAdmissions } from './plan.js';
import {
  NodeExecutorFailure,
  type InlineNodeRegistry,
} from '@pertexo/node-sdk/server';
import type { JsonValue } from '@pertexo/workflow-model';
import {
  assertNotAborted,
  isNodeExecutorFailure,
} from '../attempt/admission.js';
import { WorkflowEngineError } from '../workflow-engine.errors.js';
import { readInlineAttemptInput } from './inline-attempt-input.js';
import type {
  Chain,
  Candidate,
  InlineAdvanceOptions,
} from './advance-inline-chain.js';

export async function prepareInlineInvocation(
  {
    input,
    options,
    state,
    settled,
  }: Pick<Chain, 'input' | 'options' | 'state' | 'settled'>,
  { invocation, node }: Candidate,
  { remaining, stopAt }: Readonly<{ remaining: number; stopAt: number }>,
) {
  const startedAt = options.now();
  const started = options.monotonicNow();
  const deadlineRemaining =
    options.deadlineAt === undefined
      ? Number.POSITIVE_INFINITY
      : options.deadlineAt - startedAt;
  if (deadlineRemaining <= 0)
    return {
      kind: 'deadline' as const,
      occurredAt: new Date(startedAt).toISOString(),
    };
  const expiry = AbortSignal.timeout(
    Math.ceil(Math.min(remaining, deadlineRemaining)),
  );
  const signal = AbortSignal.any([input.signal, expiry]);
  let mapped: JsonValue | undefined;
  let outputAdmitted = true;
  let result: ReturnType<InlineNodeRegistry['executeInline']> | undefined;
  let failure: ReturnType<InlineAdvanceOptions['normalizeFailure']> | undefined;
  try {
    mapped = await readInlineAttemptInput(input, {
      state,
      invocation,
      settled,
      options,
      signal,
    });
    assertNotAborted(signal);
    try {
      result = options.registry.executeInline({
        definition: node.definition,
        executor: node.executor,
        config: node.config,
        input: mapped,
        now: startedAt,
      });
    } catch (error) {
      if (isNodeExecutorFailure(error)) throw error;
      throw new WorkflowEngineError(
        'attempt_invalid',
        'node execution failed',
        { cause: error },
      );
    }
    if (result.kind === 'succeeded')
      outputAdmitted = options.canStore?.(result.output) ?? true;
    else
      failure = options.normalizeFailure(
        new NodeExecutorFailure({
          ...result.failure,
          possiblyDispatched: false,
        }),
      );
  } catch (error) {
    assertNotAborted(input.signal);
    if (!expiry.aborted) failure = options.normalizeFailure(error);
  }

  assertNotAborted(input.signal);
  const completedAt = options.now();
  const completed = options.monotonicNow();
  const timedOut =
    options.deadlineAt !== undefined &&
    (completedAt >= options.deadlineAt ||
      (expiry.aborted && deadlineRemaining <= remaining));
  if (!timedOut && (expiry.aborted || completed >= stopAt))
    return { kind: 'budget' as const };
  return {
    kind: 'prepared' as const,
    startedAt: new Date(startedAt).toISOString(),
    occurredAt: new Date(completedAt).toISOString(),
    durationMillis: completed - started,
    mapped,
    timedOut,
    outputAdmitted,
    result,
    failure,
  };
}

export type PreparedInlineInvocation = Extract<
  Awaited<ReturnType<typeof prepareInlineInvocation>>,
  { kind: 'prepared' }
>;

type InlineFrontier =
  | Readonly<{ kind: 'inline'; candidate: Candidate }>
  | Readonly<{ kind: 'delivery'; attemptKeys: readonly string[] }>;

export function inlineFrontier(chain: Chain): InlineFrontier {
  const { input, state } = chain;
  const keys = selectReadyAdmissions(
    state,
    input.maximumAdmissions,
    input.hasExecutionSlot ?? true,
  );
  const [first] = keys;
  const candidate =
    first === undefined ? undefined : inlineCandidate(chain, first);
  if (candidate !== undefined) return { kind: 'inline', candidate };
  // Deliver attempt-class work at this frontier. Its outcomes wake any pure
  // siblings left ready while the frontier is outstanding.
  return {
    kind: 'delivery',
    attemptKeys: keys.filter(
      (key) => inlineCandidate(chain, key) === undefined,
    ),
  };
}

function inlineCandidate(
  { input, options, state, nodes }: Chain,
  key: string,
): Candidate | undefined {
  const invocation = state.invocations.get(key);
  const node =
    invocation === undefined ? undefined : nodes.get(invocation.nodeId);
  if (
    node === undefined ||
    invocation === undefined ||
    !options.registry.canExecuteInline(node.definition) ||
    (input.test !== undefined &&
      testStepDisposition(node, input.test).kind !== 'execute')
  )
    return undefined;
  return { invocation, node };
}
