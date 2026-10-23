import type { DatabaseConfig } from '@pertexo/database/testing';

import type { Queue } from 'bullmq';
import type { QueryResult, QueryResultRow } from 'pg';

import type { scheduleAuthoringOptions } from './authoring.js';

export interface ScheduleTriggerFixture {
  readonly actorId: string;
  readonly apiConfig: DatabaseConfig;
  readonly authoringOptions: ReturnType<typeof scheduleAuthoringOptions>;
  readonly close: () => Promise<void>;
  readonly dispatcherConfig: DatabaseConfig;
  readonly ownerQuery: <Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters?: unknown[],
  ) => Promise<QueryResult<Row>>;
  readonly ownerQueryIn: <Row extends QueryResultRow = QueryResultRow>(
    workspaceId: string,
    statement: string,
    parameters?: unknown[],
  ) => Promise<QueryResult<Row>>;
  readonly queue: Queue;
  readonly redisUrl: string;
  readonly setup: () => Promise<void>;
  readonly workerConfig: DatabaseConfig;
  readonly workerQuery: <Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters?: unknown[],
  ) => Promise<QueryResult<Row>>;
  readonly apiQuery: <Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters?: unknown[],
    manualStart?: Readonly<{ workflowId: string; keyHash: string }>,
  ) => Promise<QueryResult<Row>>;
  readonly workspaceId: string;
}
