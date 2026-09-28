import type {
  DatabaseConfig,
  WorkflowAuthoringDatabase,
  WorkspaceDatabase,
} from '@pertexo/database/api';
import type { JsonataEvaluator } from '@pertexo/workflow-model/expressions';
import { describe, expect, it, vi } from 'vitest';

import type { RunEventNotificationPublisher } from '../../src/executions/index.js';
import type { ApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';
import { createApiWorkflowRuntime } from '../../src/platform/workflow/workflow-runtime.module.js';
import type { WorkflowAuthoringTelemetry } from '../../src/workflow-authoring/index.js';
import type {
  WorkflowRunEventStreamer,
  WorkflowRunPersistence,
} from '../../src/workflow-runs/index.js';

const databaseConfig: DatabaseConfig = {
  connectionString: 'postgresql://api:secret@localhost:5432/pertexo',
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  max: 5,
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
};

const authorization = {
  findAccess: () => Promise.resolve(undefined),
};
const identityRuntime = {
  dependencies: { authorization },
} as unknown as ApiIdentityRuntime;
const persistence = {
  start: () => Promise.reject(new Error('not exercised')),
  replay: () => Promise.reject(new Error('not exercised')),
  get: () => Promise.resolve(undefined),
  list: () => Promise.resolve({ items: [] }),
  statistics: () => Promise.reject(new Error('not exercised')),
  cancel: () => Promise.reject(new Error('not exercised')),
  readInput: () => Promise.resolve(undefined),
  readNodeRunOutput: () => Promise.resolve(undefined),
  readNodeRunInput: () => Promise.resolve(undefined),
  stepHealth: () => Promise.resolve(undefined),
  stepRuns: () => Promise.resolve(undefined),
} satisfies WorkflowRunPersistence;
const streamer = {
  stream: () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true as const, value: undefined }),
    }),
  }),
} satisfies WorkflowRunEventStreamer;
const telemetry: WorkflowAuthoringTelemetry = {
  measure: <T>(_operation: never, work: () => Promise<T>): Promise<T> => work(),
};

function authoringDatabase(
  close: () => Promise<void>,
): WorkflowAuthoringDatabase {
  return { close } as unknown as WorkflowAuthoringDatabase;
}

function eventDatabase(close: () => Promise<void>): WorkspaceDatabase {
  return { close } as unknown as WorkspaceDatabase;
}

function notifications(
  close: () => Promise<void>,
): RunEventNotificationPublisher {
  return {
    publish: () => Promise.resolve({ receivers: 0 }),
    resync: () => Promise.resolve({ receivers: 0 }),
    close,
  };
}

describe('API workflow runtime ownership', () => {
  it('drains one shared authoring owner before database disposal even when worker disposal fails', async () => {
    let rejectDrain: (reason: unknown) => void = () => {
      throw new Error('drain not initialized');
    };
    const drain = new Promise<void>((_resolve, reject) => {
      rejectDrain = reject;
    });
    const shutdown = vi.fn(() => drain);
    const validate = vi.fn().mockRejectedValue(new Error('not exercised'));
    const close = vi.fn().mockResolvedValue(undefined);
    const databaseFactory = vi.fn(() => authoringDatabase(close));
    const runtime = await createApiWorkflowRuntime(
      databaseConfig,
      identityRuntime,
      'redis://unused',
      {
        authoring: {
          databaseFactory,
          telemetry,
          authoringValidatorFactory: () => ({ validate, shutdown }),
        },
        persistence: { runs: persistence },
        streaming: { streamer },
      },
    );
    const first = runtime.close();
    const failure = expect(first).rejects.toBeInstanceOf(AggregateError);
    expect(runtime.close()).toBe(first);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    rejectDrain(new Error('unconfirmed worker exit'));
    await failure;
    expect(close).toHaveBeenCalledOnce();
  });

  it('cleans up the authoring owner after construction fails and never allocates it for an injected database', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const factory = vi.fn(() => ({
      validate: vi.fn().mockRejectedValue(new Error('not exercised')),
      shutdown,
    }));
    await expect(
      createApiWorkflowRuntime(
        databaseConfig,
        identityRuntime,
        'redis://unused',
        {
          authoring: {
            databaseFactory: () => {
              throw new Error('construction failed');
            },
            authoringValidatorFactory: factory,
          },
        },
      ),
    ).rejects.toThrow('construction failed');
    expect(shutdown).toHaveBeenCalledOnce();
    const runtime = await createApiWorkflowRuntime(
      databaseConfig,
      identityRuntime,
      'redis://unused',
      {
        authoring: {
          database: authoringDatabase(vi.fn().mockResolvedValue(undefined)),
          telemetry,
          authoringValidatorFactory: factory,
        },
        persistence: { runs: persistence },
        streaming: { streamer },
      },
    );
    await runtime.close();
    expect(factory).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('starts every shutdown thunk and caches the aggregate close outcome', async () => {
    const authoringFailure = new Error('authoring close failed');
    const runFailure = Object.freeze({ source: 'runs' });
    const authoringClose = vi.fn(() => {
      throw authoringFailure;
    });
    const runClose = vi.fn().mockRejectedValue(runFailure);
    const eventClose = vi.fn().mockResolvedValue(undefined);
    const notificationClose = vi.fn().mockResolvedValue(undefined);
    const evaluatorShutdown = vi.fn().mockResolvedValue(undefined);

    const runtime = await createApiWorkflowRuntime(
      databaseConfig,
      identityRuntime,
      'redis://localhost:6379/0',
      {
        authoring: {
          databaseFactory: () => authoringDatabase(authoringClose),
          telemetry,
          expressionEvaluatorFactory: () =>
            ({ shutdown: evaluatorShutdown }) as unknown as JsonataEvaluator,
        },
        persistence: {
          notificationsFactory: () => notifications(notificationClose),
          runsFactory: () => ({ persistence, close: runClose }),
        },
        streaming: {
          databaseFactory: () => eventDatabase(eventClose),
          liveSource: { subscribe: () => Promise.reject(new Error('unused')) },
          streamerFactory: () => streamer,
        },
      },
    );

    const firstClose = runtime.close();
    const secondClose = runtime.close();
    expect(secondClose).toBe(firstClose);
    await expect(firstClose).rejects.toMatchObject({
      errors: [authoringFailure, runFailure],
      message: 'Workflow resource shutdown failed',
    });
    expect(authoringClose).toHaveBeenCalledOnce();
    expect(runClose).toHaveBeenCalledOnce();
    expect(eventClose).toHaveBeenCalledOnce();
    expect(notificationClose).toHaveBeenCalledOnce();
    expect(evaluatorShutdown).toHaveBeenCalledOnce();
  });

  it('rolls back every acquired owner and preserves startup plus cleanup failures', async () => {
    const startupFailure = new Error('streamer construction failed');
    const authoringFailure = new Error('authoring rollback failed');
    const authoringClose = vi.fn(() => {
      throw authoringFailure;
    });
    const runClose = vi.fn().mockRejectedValue(undefined);
    const eventClose = vi.fn().mockResolvedValue(undefined);
    const notificationClose = vi.fn().mockResolvedValue(undefined);

    const construction = createApiWorkflowRuntime(
      databaseConfig,
      identityRuntime,
      'redis://localhost:6379/0',
      {
        authoring: {
          databaseFactory: () => authoringDatabase(authoringClose),
          telemetry,
        },
        persistence: {
          notificationsFactory: () => notifications(notificationClose),
          runsFactory: () => ({ persistence, close: runClose }),
        },
        streaming: {
          databaseFactory: () => eventDatabase(eventClose),
          liveSource: { subscribe: () => Promise.reject(new Error('unused')) },
          streamerFactory: () => {
            throw startupFailure;
          },
        },
      },
    );

    await expect(construction).rejects.toMatchObject({
      errors: [startupFailure, authoringFailure, undefined],
      message: 'Workflow runtime construction and cleanup failed',
    });
    expect(authoringClose).toHaveBeenCalledOnce();
    expect(runClose).toHaveBeenCalledOnce();
    expect(eventClose).toHaveBeenCalledOnce();
    expect(notificationClose).toHaveBeenCalledOnce();
  });
});
