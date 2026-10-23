import type { createRoutingBase } from './setup.js';
import type { startRoutingWorkers } from './start.js';

export type RoutingBase = Awaited<ReturnType<typeof createRoutingBase>>;

export type RoutingScenario = RoutingBase &
  Awaited<ReturnType<typeof startRoutingWorkers>>;
