import type { CodeSettings } from '@pertexo/node-sdk';

import type {
  DatabaseConfig,
  DatabaseRuntime,
  WorkspaceDatabase,
} from '@pertexo/database/platform';
import {
  createWorkflowAuthoringDatabase,
  type WorkflowAuthoringDatabase,
} from '@pertexo/database/authoring';
import { WorkflowAuthoringValidator } from '@pertexo/workflow-model/server';

import {
  createPostgresRunEventReader,
  RedisRunEventPublisher,
  type LiveRunEventSource,
} from '../../../workflow-runs/events/index.js';

import {
  createPostgresWorkflowRunPersistence,
  createWorkflowRunEventStreamer,
  type WorkflowRunPersistence,
  type WorkflowRunsDependencies,
} from '../../../workflow-runs/index.js';
import type { createCoreWorkflowCompatibility } from '../compatibility.js';
import { createCoreAuthoringOptions } from '../compatibility.js';
import type {
  ApiWorkflowRuntimeOverrides,
  WorkflowResources,
} from './contract.js';

export function acquireAuthoringDatabase(
  databaseConfig: DatabaseConfig,
  resources: WorkflowResources,
  {
    authoring,
    compatibility,
    codeSettings,
    runtime,
  }: Readonly<{
    authoring: NonNullable<ApiWorkflowRuntimeOverrides['authoring']>;
    compatibility: ReturnType<typeof createCoreWorkflowCompatibility>;
    codeSettings: CodeSettings;
    runtime: DatabaseRuntime | undefined;
  }>,
): WorkflowAuthoringDatabase {
  if (authoring.database !== undefined) {
    resources.database = authoring.database;
  } else {
    const validator =
      authoring.authoringValidatorFactory?.() ??
      new WorkflowAuthoringValidator();
    resources.authoringValidator = validator;
    resources.database = (
      authoring.databaseFactory ?? createWorkflowAuthoringDatabase
    )(databaseConfig, {
      ...createCoreAuthoringOptions(compatibility, validator, codeSettings),
      ...(runtime === undefined ? {} : { runtime }),
    });
  }
  return resources.database;
}

export function acquireRunPersistence(
  databaseConfig: DatabaseConfig,
  resources: WorkflowResources,
  {
    persistence,
    redisUrl,
    runtime,
  }: Readonly<{
    persistence: NonNullable<ApiWorkflowRuntimeOverrides['persistence']>;
    redisUrl: string;
    runtime: DatabaseRuntime | undefined;
  }>,
): WorkflowRunPersistence | undefined {
  if (persistence.runs === undefined) {
    resources.notifications =
      persistence.notifications ??
      (
        persistence.notificationsFactory ??
        ((url) => new RedisRunEventPublisher({ redisUrl: url }))
      )(redisUrl);
    resources.runAdapter = (
      persistence.runsFactory ?? createPostgresWorkflowRunPersistence
    )(databaseConfig, undefined, resources.notifications, runtime);
  }
  return persistence.runs ?? resources.runAdapter?.persistence;
}

export function configuredRunEventStreamer(
  streaming: NonNullable<ApiWorkflowRuntimeOverrides['streaming']>,
  eventDatabase: WorkspaceDatabase | undefined,
  liveSource: LiveRunEventSource | undefined,
): WorkflowRunsDependencies['streamer'] | undefined {
  return (
    streaming.streamer ??
    (eventDatabase === undefined || liveSource === undefined
      ? undefined
      : (streaming.streamerFactory ?? createWorkflowRunEventStreamer)(
          createPostgresRunEventReader(eventDatabase),
          liveSource,
        ))
  );
}
