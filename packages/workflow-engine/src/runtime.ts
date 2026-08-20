import type { InvocationState, SideEffectClass } from './types.js';

export interface DurableWaitPlan {
  readonly invocationKey: string;
  readonly transition: 'waiting' | 'ready';
  readonly resumeAt: string | null;
  readonly releasesWorkerSlot: true;
}

export function planDurableWait(input: {
  readonly invocationKey: string;
  readonly resumeAt: string;
  readonly now: string;
}): DurableWaitPlan {
  const now = Date.parse(input.now);
  const resumeAt = Date.parse(input.resumeAt);
  if (!Number.isFinite(now) || !Number.isFinite(resumeAt)) {
    throw new TypeError('durable wait timestamps must be valid ISO timestamps');
  }
  return now >= resumeAt
    ? {
        invocationKey: input.invocationKey,
        transition: 'ready',
        resumeAt: null,
        releasesWorkerSlot: true,
      }
    : {
        invocationKey: input.invocationKey,
        transition: 'waiting',
        resumeAt: input.resumeAt,
        releasesWorkerSlot: true,
      };
}

export type CancellationDecision =
  | { readonly kind: 'stop_scheduling' }
  | {
      readonly kind: 'await_reconciliation';
      readonly invocationKeys: readonly string[];
    }
  | { readonly kind: 'canceled' }
  | {
      readonly kind: 'outcome_unknown';
      readonly invocationKeys: readonly string[];
    };

export function decideCancellation(
  invocations: readonly (InvocationState & {
    readonly possiblyDispatched?: boolean;
    readonly sideEffectClass?: SideEffectClass;
  })[],
): CancellationDecision {
  const uncertain = invocations
    .filter(
      ({ possiblyDispatched, sideEffectClass, status }) =>
        status === 'running' &&
        possiblyDispatched === true &&
        sideEffectClass === 'unsafe',
    )
    .map(({ invocationKey }) => invocationKey)
    .sort();
  if (uncertain.length > 0)
    return { kind: 'outcome_unknown', invocationKeys: uncertain };

  const active = invocations
    .filter(({ status }) => status === 'running' || status === 'waiting')
    .map(({ invocationKey }) => invocationKey)
    .sort();
  if (active.length > 0)
    return { kind: 'await_reconciliation', invocationKeys: active };
  return { kind: 'canceled' };
}
