import type { createQueueProducer } from '@pertexo/queue';

import type { Queue } from 'bullmq';

import type { acceptStructuredForEachRun } from '../../../../support/coordinator/runs.js';

import type { acceptScenarioRun } from './start.js';
import type { createForEachDelivery } from './delivery.js';

export type ForEachScenarioMode =
  | 'complete'
  | 'serial_complete'
  | 'condition_complete'
  | 'switch_complete'
  | 'nested_complete'
  | 'cancel_between_batches'
  | 'cancel_running'
  | 'deadline_running';

export type AcceptedForEachScenario = Awaited<
  ReturnType<typeof acceptScenarioRun>
>;

export type ForEachScenarioContext = Readonly<{
  ownedProducer: ReturnType<typeof createQueueProducer>;
  ownedCoordinatorQueue: Queue;
  ownedAttemptQueue: Queue;
  stopWorkers: () => Promise<void>;
  eraseRedisAndRestart: () => Promise<void>;
}>;

export type ForEachPhaseContext = Pick<
  ForEachScenarioContext,
  'stopWorkers' | 'eraseRedisAndRestart'
> &
  Readonly<{
    accepted: AcceptedForEachScenario;
    mode: ForEachScenarioMode;
    structuredKind:
      Parameters<typeof acceptStructuredForEachRun>[0] | undefined;
    delivery: ReturnType<typeof createForEachDelivery>;
  }>;
