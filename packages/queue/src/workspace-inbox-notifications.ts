import './server-only.js';

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { Redis } from 'ioredis';
import { z } from 'zod';

import {
  BoundedRedisPublisher,
  type BoundedRedisPublisherOptions,
} from './redis-bounded-publisher.js';

/** Largest hint a subscriber accepts; anything larger is discarded. */
const MAX_HINT_BYTES = 256;

const revisionSchema = z.string().regex(/^[1-9][0-9]{0,18}$/u);
const changeSchema = z
  .object({ workspaceId: z.uuid(), revision: revisionSchema })
  .strict();
const hintSchema = z
  .object({ kind: z.literal('changed'), revision: revisionSchema })
  .strict();

/** A workspace's inbox changed; the revision is the newest thread revision. */
export type WorkspaceInboxHint = z.infer<typeof hintSchema>;
export type WorkspaceInboxChangeHint = Readonly<{
  workspaceId: string;
  revision: string;
}>;

export interface WorkspaceInboxHintPublisher {
  publish(
    change: WorkspaceInboxChangeHint,
  ): Promise<{ readonly receivers: number }>;
  close(): Promise<void>;
}

export class WorkspaceInboxHintConfigurationError extends Error {
  public override readonly name = 'WorkspaceInboxHintConfigurationError';
}
export class WorkspaceInboxHintPublishError extends Error {
  public override readonly name = 'WorkspaceInboxHintPublishError';
}

/** ADR 055: an opaque per-workspace channel for content-free inbox hints. */
export function workspaceInboxChannel(workspaceId: string): string {
  const digest = createHash('sha256')
    .update(`v1\0workspace-inbox\0${z.uuid().parse(workspaceId)}`)
    .digest('base64url');
  return `workspace-inbox:v1:${digest}`;
}

export function encodeWorkspaceInboxHint(revision: string): string {
  return JSON.stringify(
    hintSchema.parse({
      kind: 'changed',
      revision,
    } satisfies WorkspaceInboxHint),
  );
}

/** Pub/sub input is untrusted; an invalid or oversized hint is ignored. */
export function parseWorkspaceInboxHint(
  message: string,
): WorkspaceInboxHint | undefined {
  if (Buffer.byteLength(message, 'utf8') > MAX_HINT_BYTES) return undefined;
  try {
    const parsed = hintSchema.safeParse(JSON.parse(message));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export class RedisWorkspaceInboxHintPublisher implements WorkspaceInboxHintPublisher {
  private readonly publisher: BoundedRedisPublisher;

  public constructor(
    options: BoundedRedisPublisherOptions,
    createRedis?: () => Redis,
  ) {
    this.publisher = new BoundedRedisPublisher(
      'workspace_inbox_publisher',
      {
        label: 'Workspace inbox hint',
        configuration: (message) =>
          new WorkspaceInboxHintConfigurationError(message),
        publish: (message) => new WorkspaceInboxHintPublishError(message),
        isPublishError: (error) =>
          error instanceof WorkspaceInboxHintPublishError,
      },
      options,
      createRedis,
    );
  }

  public publish(change: WorkspaceInboxChangeHint) {
    const parsed = changeSchema.parse(change);
    return this.publisher.publish(
      workspaceInboxChannel(parsed.workspaceId),
      encodeWorkspaceInboxHint(parsed.revision),
    );
  }

  public close(): Promise<void> {
    return this.publisher.close();
  }
}
