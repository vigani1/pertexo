import type { TransportJob } from '@pertexo/observability/server';
import { QUEUE_FOR_JOB } from '@pertexo/queue/server';
import type { JobName } from '@pertexo/queue/server';

export function transportJobForName(jobName: JobName): TransportJob {
  return { jobName, queueName: QUEUE_FOR_JOB[jobName] };
}
