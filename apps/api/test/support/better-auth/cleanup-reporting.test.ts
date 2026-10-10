import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Vitest from 'vitest';
import type { FixtureResourceOwner } from '../../browser/harness/resource-owner.js';

const fixture = vi.hoisted(() => ({
  setup: undefined as (() => Promise<void>) | undefined,
  cleanup: undefined as (() => Promise<void>) | undefined,
  poolCount: 0,
  order: [] as string[],
  failures: new Map<string, unknown>(),
}));

function close(name: string): Promise<void> {
  return Promise.resolve().then(() => {
    fixture.order.push(name);
    if (fixture.failures.has(name)) throw fixture.failures.get(name);
  });
}

vi.mock('vitest', async (original) => ({
  ...(await original<typeof Vitest>()),
  beforeAll: (callback: () => Promise<void>) => {
    fixture.setup = callback;
  },
  afterAll: (callback: () => Promise<void>) => {
    fixture.cleanup = callback;
  },
}));
vi.mock('pg', () => ({
  Pool: class {
    name =
      ['creator', 'inspection', 'cleanup pool'][fixture.poolCount++] ??
      'unexpected pool';
    query = vi.fn(() => Promise.resolve({ rows: [] }));
    end = () => close(this.name);
  },
}));
vi.mock('@pertexo/database/testing', () => ({
  parseDatabaseConfig: (config: object) => config,
  migrateDatabase: vi.fn(),
  createWorkspaceDatabase: () => ({ close: () => close('workspace database') }),
}));
vi.mock('../../../src/authentication/index.js', () => ({
  LocalAuthenticationMailSink: vi.fn(),
}));
vi.mock('../../../src/platform/identity/identity-runtime.module.js', () => ({
  createApiIdentityRuntime: () => ({ close: () => close('identity runtime') }),
}));
vi.mock('../../../src/platform/workflow/workflow-compatibility.js', () => ({
  createCoreWorkflowCompatibility: () => ({
    readinessSupport: { descriptions: [] },
  }),
}));
vi.mock('../disposable-database.js', () => ({
  dropDisconnectedDatabase: () => close('database drop'),
}));
vi.mock('./fixture-application.js', () => ({
  createBetterAuthFixtureApplication: (
    _config: unknown,
    _dependencies: unknown,
    owner: FixtureResourceOwner,
  ) =>
    owner.acquire('API application', { init: vi.fn() }, () =>
      close('application'),
    ),
}));

import { useBetterAuthRealApi } from './real-api.support.js';

async function start(options: Parameters<typeof useBetterAuthRealApi>[1] = {}) {
  useBetterAuthRealApi('reporting', options);
  if (fixture.setup === undefined || fixture.cleanup === undefined)
    throw new Error('Actual fixture hooks were not registered');
  await fixture.setup();
  return fixture.cleanup;
}

function expectSafeReport(error: unknown, labels: string[]) {
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(AggregateError);
  if (!(error instanceof Error)) throw new Error('Missing cleanup failure');
  expect(error.message).toBe(
    `Better Auth fixture cleanup failed: ${labels.join(', ')}`,
  );
  expect(Object.getOwnPropertyNames(error).sort()).toEqual([
    'message',
    'stack',
  ]);
}

beforeEach(() => {
  fixture.poolCount = 0;
  fixture.order = [];
  fixture.failures.clear();
  fixture.setup = undefined;
  fixture.cleanup = undefined;
});

describe('actual Better Auth fixture cleanup reporting', () => {
  it('closes every resource in reverse ownership order on success', async () => {
    const cleanup = await start();
    await cleanup();
    expect(fixture.order).toEqual([
      'application',
      'workspace database',
      'identity runtime',
      'inspection',
      'database drop',
      'cleanup pool',
      'creator',
    ]);
  });

  it.each([
    [
      'Disposable database connection_probe query exceeded 1000ms',
      'database_connection_probe_deadline',
    ],
    [
      'Disposable database poll_wait query exceeded 1000ms',
      'database_poll_wait_deadline',
    ],
    [
      'Disposable database drop query exceeded 9000ms',
      'database_drop_deadline',
    ],
    [
      'Disposable database drop deadline expired before dispatch',
      'database_drop_deadline',
    ],
    [
      'Disposable database drop query exceeded 9000ms: private endpoint',
      'database_cleanup_failure',
    ],
    ['Disposable database query exceeded 1000ms', 'database_query_deadline'],
    ['Query read timeout', 'database_query_read_timeout'],
    ['Unknown credential-bearing failure', 'database_cleanup_failure'],
    ['Disposable database query exceeded 0ms', 'database_cleanup_failure'],
    ['Query read timeout: private endpoint', 'database_cleanup_failure'],
  ])(
    'projects database failure without original error metadata: %s',
    async (message, label) => {
      const original = new Error(message, {
        cause: new Error('private cause'),
      });
      Object.assign(original, {
        sql: 'private SQL',
        connectionString: 'private endpoint',
      });
      fixture.failures.set('database drop', original);
      const cleanup = await start();
      expectSafeReport(await cleanup().catch((error: unknown) => error), [
        label,
      ]);
      expect(fixture.order.slice(-3)).toEqual([
        'database drop',
        'cleanup pool',
        'creator',
      ]);
    },
  );

  it('classifies the finally failure rather than a masked drop failure', async () => {
    fixture.failures.set(
      'database drop',
      new Error('Disposable database query exceeded 1000ms'),
    );
    fixture.failures.set('cleanup pool', new Error('other private failure'));
    const cleanup = await start();
    expectSafeReport(await cleanup().catch((error: unknown) => error), [
      'database_cleanup_failure',
    ]);
  });

  it('does not invoke a message getter', async () => {
    const getter = vi.fn(() => 'Query read timeout');
    const original = new Error();
    Object.defineProperty(original, 'message', { get: getter });
    fixture.failures.set('database drop', original);
    const cleanup = await start();
    expectSafeReport(await cleanup().catch((error: unknown) => error), [
      'database_cleanup_failure',
    ]);
    expect(getter).not.toHaveBeenCalled();
  });

  it('reports simultaneous other failures while attempting all cleanup', async () => {
    fixture.failures.set(
      'application',
      new Error('private application failure'),
    );
    fixture.failures.set('creator', new Error('Query read timeout'));
    fixture.failures.set('database drop', new Error('Query read timeout'));
    const cleanup = await start();
    expectSafeReport(await cleanup().catch((error: unknown) => error), [
      'database_query_read_timeout',
      'other_cleanup_failure',
    ]);
    expect(fixture.order).toHaveLength(7);
  });

  it('does not classify another resource as a database drop timeout', async () => {
    fixture.failures.set('application', new Error('Query read timeout'));
    const cleanup = await start();
    expectSafeReport(await cleanup().catch((error: unknown) => error), [
      'other_cleanup_failure',
    ]);
  });

  it('retains the disposable database when beforeClose is uncertain', async () => {
    const cleanup = await start({
      beforeClose: () =>
        Promise.reject(new Error('private ownership uncertainty')),
    });
    expectSafeReport(await cleanup().catch((error: unknown) => error), [
      'other_cleanup_failure',
    ]);
    expect(fixture.order).toEqual([
      'application',
      'workspace database',
      'identity runtime',
      'inspection',
      'creator',
    ]);
  });

  it('retains the database and closes remaining resources after a synchronous beforeClose throw', async () => {
    const failure = new Error('private synchronous failure', {
      cause: new Error('private cause'),
    });
    Object.assign(failure, { connectionString: 'private endpoint' });
    const cleanup = await start({
      beforeClose: () => {
        throw failure;
      },
    });
    expectSafeReport(await cleanup().catch((error: unknown) => error), [
      'other_cleanup_failure',
    ]);
    expect(fixture.order).toEqual([
      'application',
      'workspace database',
      'identity runtime',
      'inspection',
      'creator',
    ]);
  });
});
