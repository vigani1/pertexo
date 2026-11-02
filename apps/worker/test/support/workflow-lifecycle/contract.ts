import type { DatabaseConfig } from '@pertexo/database/testing';
import type { WorkflowAuthoringStore } from '@pertexo/core/testing';

import type { Queue } from 'bullmq';
import type { QueryResult, QueryResultRow } from 'pg';

import type { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/runtime.js';
import type { TriggerRuntime } from '../../../src/triggers/runtime.js';

export const lifecycleRunKeys = [
  'queued',
  'running',
  'waiting',
  'succeeded',
] as const;

export type LifecycleRunKey = (typeof lifecycleRunKeys)[number];

export type LifecycleIds = Readonly<{
  workflow: string;
  version: string;
  activeWebhook: string;
  activeSchedule: string;
  disabledWebhook: string;
  disabledSchedule: string;
  activeWebhookEndpoint: string;
  disabledWebhookEndpoint: string;
  activeWebhookSecret: string;
  disabledWebhookSecret: string;
  runs: Readonly<Record<LifecycleRunKey, string>>;
}>;

export type LifecycleProjection = Readonly<{
  workflow: Readonly<{
    lifecycleStatus: string;
    lifecycleRevision: number;
    activationStatus: string;
    publishedVersionId: string | null;
  }>;
  triggers: readonly Readonly<{
    id: string;
    kind: string;
    status: string;
    healthStatus: string;
    configFingerprint: string;
  }>[];
  endpoints: readonly Readonly<{
    id: string;
    status: string;
  }>[];
  schedules: readonly Readonly<{
    triggerId: string;
    status: string;
    healthStatus: string;
    configFingerprint: string;
  }>[];
}>;

export type RunSnapshot = Readonly<{
  runs: Readonly<Record<LifecycleRunKey, string>>;
  events: Readonly<Record<LifecycleRunKey, readonly string[]>>;
  checkpoints: Readonly<Record<LifecycleRunKey, string>>;
}>;

export type LifecycleOutboxEvent = Readonly<{
  id: string;
  payload: Readonly<{
    workspaceId: string;
    workflowId: string;
    publishedVersionId: string;
    outboxEventId: string;
  }>;
}>;

export type Closeable = Readonly<{ close(): Promise<unknown> }>;

export type OwnedResource = Readonly<{
  close(): Promise<void>;
  label: string;
  resource: object;
}>;

export type WorkflowLifecycleWorkerEnvironment = Readonly<{
  apiConfig: DatabaseConfig;
  workerConfig: DatabaseConfig;
  dispatcherConfig: DatabaseConfig;
  actorId: string;
  workspaceId: string;
  ids: LifecycleIds;
  authoring: WorkflowAuthoringStore;
  queue: Queue;
  initialize(): Promise<void>;
  ownerQuery<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  workerQuery<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  transition(
    command: 'archive' | 'restore',
    expectedLifecycleRevision: number,
    idempotencyKey: string,
  ): ReturnType<WorkflowAuthoringStore['transitionWorkflowLifecycle']>;
  readProjection(): Promise<LifecycleProjection>;
  readRunSnapshot(): Promise<RunSnapshot>;
  readOutboxEvent(id: string): Promise<LifecycleOutboxEvent>;
  makeDue(id: string): Promise<void>;
  createRuntime(leaseOwner: string): Promise<TriggerRuntime>;
  createDispatcher(leaseOwner: string): OutboxDispatcher;
  close(): Promise<void>;
}>;
