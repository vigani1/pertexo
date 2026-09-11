import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';

type ProviderDispatchState = Pick<
  NodeExecutionRuntime,
  | 'providerIdempotencyKey'
  | 'providerDispatchBinding'
  | 'providerDispatchUnresolved'
>;

export function nodeExecutionOptionalFields(
  dispatch: ProviderDispatchState,
  connections: NodeExecutionRuntime['connections'] | undefined,
  artifacts: NodeExecutionRuntime['artifacts'] | undefined,
): Partial<NodeExecutionRuntime> {
  return {
    ...(dispatch.providerIdempotencyKey === undefined
      ? {}
      : { providerIdempotencyKey: dispatch.providerIdempotencyKey }),
    ...(dispatch.providerDispatchBinding === undefined
      ? {}
      : { providerDispatchBinding: dispatch.providerDispatchBinding }),
    ...(dispatch.providerDispatchUnresolved === undefined
      ? {}
      : { providerDispatchUnresolved: true as const }),
    ...(connections === undefined ? {} : { connections }),
    ...(artifacts === undefined ? {} : { artifacts }),
  };
}
