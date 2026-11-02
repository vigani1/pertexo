import { runPorts } from '../support/run-ports.js';
import type { DatabaseConfig } from '@pertexo/database/platform';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiIdentityRuntime } from '../../src/platform/identity/runtime.module.js';
import { createApiWorkflowRuntime } from '../../src/platform/workflow/runtime.module.js';

const outside = vi.hoisted(() => ({
  authoring: vi.fn(),
  inputCases: vi.fn(),
  events: vi.fn(),
  runs: vi.fn(),
  streamer: vi.fn(),
  notifications: vi.fn(),
  liveSource: vi.fn(),
  evaluator: vi.fn(),
  validator: vi.fn(),
}));

vi.mock('@pertexo/core/authoring', async (original) => ({
  ...(await original<object>()),
  createWorkflowAuthoringStore: outside.authoring,
  createWorkflowInputCaseDatabase: outside.inputCases,
}));
vi.mock('@pertexo/database/platform', async (original) => ({
  ...(await original<object>()),
  createWorkspaceDatabase: outside.events,
}));
vi.mock('@pertexo/workflow-model/server', async (original) => ({
  ...(await original<object>()),
  JsonataEvaluator: function JsonataEvaluator() {
    return outside.evaluator() as object;
  },
  WorkflowAuthoringValidator: function WorkflowAuthoringValidator() {
    return outside.validator() as object;
  },
}));
vi.mock('../../src/workflow-runs/index.js', async (original) => ({
  ...(await original<object>()),
  createPostgresWorkflowRunPersistence: outside.runs,
  createWorkflowRunEventStreamer: outside.streamer,
}));
vi.mock('../../src/workflow-runs/events/index.js', async (original) => ({
  ...(await original<object>()),
  RedisRunEventPublisher: function RedisRunEventPublisher() {
    return outside.notifications() as object;
  },
  RedisRunEventSource: function RedisRunEventSource() {
    return outside.liveSource() as object;
  },
}));

const databaseConfig: DatabaseConfig = {
  connectionString: 'postgresql://api:secret@localhost:5432/pertexo',
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  max: 5,
  ownerRole: 'pertexo_owner',
};

const authorization = {
  findAccess: () => Promise.resolve(undefined),
};
const identityRuntime = {
  dependencies: { authorization },
} as unknown as ApiIdentityRuntime;
const { persistence, streamer } = runPorts();
const options = { redisUrl: 'redis://localhost:6379/0' };

function closes(close: () => unknown = vi.fn().mockResolvedValue(undefined)) {
  return { close };
}

describe('API workflow runtime ownership', () => {
  beforeEach(() => {
    outside.authoring.mockReset().mockReturnValue(closes());
    outside.inputCases.mockReset().mockReturnValue(closes());
    outside.events.mockReset().mockReturnValue(closes());
    outside.runs.mockReset().mockReturnValue({ ...closes(), persistence });
    outside.streamer.mockReset().mockReturnValue(streamer);
    outside.notifications.mockReset().mockReturnValue(closes());
    outside.liveSource.mockReset().mockReturnValue({
      subscribe: () => Promise.reject(new Error('unused')),
    });
    outside.evaluator
      .mockReset()
      .mockReturnValue({ shutdown: vi.fn().mockResolvedValue(undefined) });
    outside.validator.mockReset().mockReturnValue({
      validate: vi.fn().mockRejectedValue(new Error('not exercised')),
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('builds case persistence from configuration and exposes it to authoring', async () => {
    const caseClose = vi.fn().mockResolvedValue(undefined);
    const cases = closes(caseClose);
    outside.inputCases.mockReturnValue(cases);
    const runtime = await createApiWorkflowRuntime(
      databaseConfig,
      identityRuntime,
      options,
    );
    expect(outside.inputCases).toHaveBeenCalledWith(databaseConfig, {});
    expect(runtime.dependencies.inputCasePersistence).toBe(cases);
    await runtime.close();
    expect(caseClose).toHaveBeenCalledOnce();
  });

  it('closes case persistence once even on shutdown failure', async () => {
    const caseClose = vi.fn().mockRejectedValue(new Error('case close failed'));
    const close = vi.fn().mockResolvedValue(undefined);
    outside.inputCases.mockReturnValue(closes(caseClose));
    outside.authoring.mockReturnValue(closes(close));
    const runtime = await createApiWorkflowRuntime(
      databaseConfig,
      identityRuntime,
      options,
    );
    const shuttingDown = runtime.close();
    expect(runtime.close()).toBe(shuttingDown);
    await expect(shuttingDown).rejects.toBeInstanceOf(AggregateError);
    expect(caseClose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('cleans up case persistence after later runtime construction fails', async () => {
    const caseClose = vi.fn().mockResolvedValue(undefined);
    outside.inputCases.mockReturnValue(closes(caseClose));
    outside.runs.mockImplementation(() => {
      throw new Error('runs failed');
    });
    await expect(
      createApiWorkflowRuntime(databaseConfig, identityRuntime, options),
    ).rejects.toThrow('runs failed');
    expect(caseClose).toHaveBeenCalledOnce();
  });

  it('drains one shared authoring owner before database disposal even when worker disposal fails', async () => {
    let rejectDrain: (reason: unknown) => void = () => {
      throw new Error('drain not initialized');
    };
    const drain = new Promise<void>((_resolve, reject) => {
      rejectDrain = reject;
    });
    const shutdown = vi.fn(() => drain);
    const close = vi.fn().mockResolvedValue(undefined);
    outside.validator.mockReturnValue({ validate: vi.fn(), shutdown });
    outside.authoring.mockReturnValue(closes(close));
    const runtime = await createApiWorkflowRuntime(
      databaseConfig,
      identityRuntime,
      options,
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

  it('cleans up the authoring owner after construction fails', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    outside.validator.mockReturnValue({ validate: vi.fn(), shutdown });
    outside.authoring.mockImplementation(() => {
      throw new Error('construction failed');
    });
    await expect(
      createApiWorkflowRuntime(databaseConfig, identityRuntime, options),
    ).rejects.toThrow('construction failed');
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
    const evaluatorShutdowns: ReturnType<typeof vi.fn>[] = [];
    outside.authoring.mockReturnValue(closes(authoringClose));
    outside.runs.mockReturnValue({ persistence, close: runClose });
    outside.events.mockReturnValue(closes(eventClose));
    outside.notifications.mockReturnValue(closes(notificationClose));
    outside.evaluator.mockImplementation(() => {
      const shutdown = vi.fn().mockResolvedValue(undefined);
      evaluatorShutdowns.push(shutdown);
      return { shutdown };
    });

    const runtime = await createApiWorkflowRuntime(
      databaseConfig,
      identityRuntime,
      options,
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
    expect(evaluatorShutdowns).not.toHaveLength(0);
    for (const shutdown of evaluatorShutdowns)
      expect(shutdown).toHaveBeenCalledOnce();
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
    outside.authoring.mockReturnValue(closes(authoringClose));
    outside.runs.mockReturnValue({ persistence, close: runClose });
    outside.events.mockReturnValue(closes(eventClose));
    outside.notifications.mockReturnValue(closes(notificationClose));
    outside.streamer.mockImplementation(() => {
      throw startupFailure;
    });

    await expect(
      createApiWorkflowRuntime(databaseConfig, identityRuntime, options),
    ).rejects.toMatchObject({
      errors: [startupFailure, authoringFailure, undefined],
      message: 'Workflow runtime construction and cleanup failed',
    });
    expect(authoringClose).toHaveBeenCalledOnce();
    expect(runClose).toHaveBeenCalledOnce();
    expect(eventClose).toHaveBeenCalledOnce();
    expect(notificationClose).toHaveBeenCalledOnce();
  });
});
