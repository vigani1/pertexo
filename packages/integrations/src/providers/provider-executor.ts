import type { ExecutorIdentity } from '@pertexo/node-sdk';
import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

/** How an app measures one provider step's execution (metrics, spans). */
export interface ExecutorTelemetry<Output> {
  measure(work: () => Promise<Output>): Promise<Output>;
}

/** Registers a provider step, measured by the app's telemetry when it has one. */
export function registerProviderExecutor<Output>(
  executor: ExecutorIdentity,
  telemetry: ExecutorTelemetry<Output> | undefined,
  execute: (
    invocation: NodeExecutionInvocation<unknown, unknown>,
  ) => Promise<Output>,
): NodeExecutorRegistration {
  return Object.freeze({
    executor,
    execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
      telemetry === undefined
        ? execute(invocation)
        : telemetry.measure(() => execute(invocation)),
  });
}
