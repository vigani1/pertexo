import type { TransportJob } from '@pertexo/observability';
import { QUEUE_FOR_JOB } from '@pertexo/queue';
import type { JobName } from '@pertexo/queue';

export function transportJobForName(jobName: JobName): TransportJob {
  return { jobName, queueName: QUEUE_FOR_JOB[jobName] };
}
