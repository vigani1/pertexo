import { JOB_NAME, type JobName, type QueueConsumer } from '@pertexo/queue';
import { z } from 'zod';

const jobNamesSchema = z
  .array(z.enum(JOB_NAME))
  .max(Object.keys(JOB_NAME).length)
  .refine((values) => new Set(values).size === values.length);

type ConsumerReadiness = Pick<QueueConsumer, 'isReady' | 'waitUntilReady'>;

export type DispatchConsumerCapability = Readonly<{
  consumer: ConsumerReadiness;
  jobName: JobName;
}>;

export interface DispatchConsumerCapabilityRegistry {
  assertReady(jobNames: readonly JobName[]): Promise<void>;
  readyJobNames(): readonly JobName[];
}

export class DispatchConsumerCapabilityError extends Error {
  public override readonly name = 'DispatchConsumerCapabilityError';

  public constructor(jobName: JobName) {
    super(`No ready composed consumer for dispatch job ${jobName}`);
  }
}

export function createDispatchConsumerCapabilityRegistry(
  capabilities: readonly DispatchConsumerCapability[],
): DispatchConsumerCapabilityRegistry {
  const parsedJobNames = jobNamesSchema.parse(
    capabilities.map((capability) => capability.jobName),
  );
  const consumers = new Map<JobName, ConsumerReadiness>();
  for (const [index, jobName] of parsedJobNames.entries()) {
    const consumer = capabilities[index]?.consumer;
    if (consumer === undefined) {
      throw new TypeError('Dispatch consumer capability is incomplete');
    }
    consumers.set(jobName, consumer);
  }

  function selected(
    jobNames: readonly JobName[],
  ): readonly ConsumerReadiness[] {
    const parsed = jobNamesSchema.parse([...jobNames]);
    return parsed.map((jobName) => {
      const consumer = consumers.get(jobName);
      if (consumer === undefined) {
        throw new DispatchConsumerCapabilityError(jobName);
      }
      return consumer;
    });
  }

  return Object.freeze({
    assertReady: async (jobNames: readonly JobName[]): Promise<void> => {
      const selectedConsumers = selected(jobNames);
      await Promise.all(
        selectedConsumers.map((consumer) => consumer.waitUntilReady()),
      );
      for (const [index, consumer] of selectedConsumers.entries()) {
        if (!consumer.isReady()) {
          const jobName = jobNames[index];
          if (jobName === undefined) {
            throw new TypeError('Dispatch consumer capability disappeared');
          }
          throw new DispatchConsumerCapabilityError(jobName);
        }
      }
    },
    readyJobNames: (): readonly JobName[] =>
      Object.freeze(
        parsedJobNames.filter((jobName) => consumers.get(jobName)?.isReady()),
      ),
  });
}

export const NO_DISPATCH_CONSUMER_CAPABILITIES =
  createDispatchConsumerCapabilityRegistry([]);
