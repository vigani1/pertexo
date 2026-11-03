import type { RouteInput } from '@pertexo/contracts/server';

/** What a route hands its handler once the declared input has parsed. */
export function routeInput<Route>(
  values: Partial<RouteInput<Route>> & Pick<RouteInput<Route>, 'params'>,
): RouteInput<Route> {
  return {
    query: {},
    body: undefined,
    idempotencyKey: undefined,
    headers: undefined,
    ...values,
  } as RouteInput<Route>;
}
