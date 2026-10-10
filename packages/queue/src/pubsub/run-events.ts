import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { Redis } from 'ioredis';
import { z } from 'zod';

import {
  BoundedRedisPublisher,
  type BoundedRedisPublisherOptions,
} from './bounded-publisher.js';

const MAX_LIVE_MESSAGE_BYTES = 512;
const identitySchema = z
  .object({ runId: z.uuid(), workspaceId: z.uuid() })
  .strict();
const eventReferenceSchema = identitySchema
  .extend({ sequence: z.number().int().positive() })
  .strict();

export type RunEventNotificationPublisherOptions = BoundedRedisPublisherOptions;
export interface RunEventIdentity {
  readonly runId: string;
  readonly workspaceId: string;
}
export interface RunEventReference extends RunEventIdentity {
  readonly sequence: number;
}
export interface RunEventNotificationPublisher {
  close(): Promise<void>;
  publish(
    reference: RunEventReference,
  ): Promise<{ readonly receivers: number }>;
  resync(identity: RunEventIdentity): Promise<{ readonly receivers: number }>;
}

export class RunEventNotificationConfigurationError extends Error {
  public override readonly name = 'RunEventNotificationConfigurationError';
}
export class RunEventNotificationPublishError extends Error {
  public override readonly name = 'RunEventNotificationPublishError';
}

export function runEventChannel(workspaceId: string, runId: string): string {
  const identity = identitySchema.parse({ workspaceId, runId });
  const digest = createHash('sha256')
    .update(`v1\0${identity.workspaceId}\0${identity.runId}`)
    .digest('base64url');
  return `run-events:${digest}`;
}

export function encodeRunEventReference(reference: RunEventReference): string {
  return boundedMessage({
    kind: 'event',
    ...eventReferenceSchema.parse(reference),
  });
}

export function encodeRunEventResync(identity: RunEventIdentity): string {
  identitySchema.parse(identity);
  return boundedMessage({ kind: 'resync' });
}

function boundedMessage(value: unknown): string {
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload, 'utf8') > MAX_LIVE_MESSAGE_BYTES)
    throw new RunEventNotificationPublishError(
      'Run event notification exceeds its bounded payload limit',
    );
  return payload;
}

export class RedisRunEventNotificationPublisher implements RunEventNotificationPublisher {
  private readonly publisher: BoundedRedisPublisher;

  public constructor(
    options: RunEventNotificationPublisherOptions,
    createRedis?: () => Redis,
  ) {
    this.publisher = new BoundedRedisPublisher(
      'run_event_publisher',
      {
        label: 'Run event',
        configuration: (message) =>
          new RunEventNotificationConfigurationError(message),
        publish: (message) => new RunEventNotificationPublishError(message),
        isPublishError: (error) =>
          error instanceof RunEventNotificationPublishError,
      },
      options,
      createRedis,
    );
  }

  public close(): Promise<void> {
    return this.publisher.close();
  }

  public publish(reference: RunEventReference) {
    const parsed = eventReferenceSchema.parse(reference);
    return this.publisher.publish(
      runEventChannel(parsed.workspaceId, parsed.runId),
      encodeRunEventReference(parsed),
    );
  }

  public resync(identity: RunEventIdentity) {
    const parsed = identitySchema.parse(identity);
    return this.publisher.publish(
      runEventChannel(parsed.workspaceId, parsed.runId),
      encodeRunEventResync(parsed),
    );
  }
}
