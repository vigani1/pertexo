import { fork, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Pool } from 'pg';
import {
  ConnectionEnvelopeEncryption,
  type ConnectionSecretContext,
} from '@pertexo/integrations/server';
import { createEditorBrowserEnvelopeKeys } from '../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import { createEditorWebhookRuntime } from './support/editor-webhook-runtime.js';
import { createEditorHttpControl } from './support/editor-http-control.js';
import {
  httpCohort,
  httpEffectsSchema,
  submittedHttpEvidenceIds,
  verifyHttpEvidence,
} from './support/editor-http-evidence.js';
import { createStructuredLogger } from '@pertexo/observability/logging';
import { workspaceResponseSchema } from '@pertexo/contracts/schemas/identity-workspace';
import {
  workflowCreateResponseSchema,
  workflowGraphSchema,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { FixtureResourceOwner } from './support/fixture-resource-owner.js';
import { useBetterAuthRealApi } from './support/better-auth-real-api.integration.support.js';
import { ownEditorBrowserProcess } from './support/editor-browser-process.js';
import { verifyEditorBrowserOwnership } from './support/editor-browser-ownership.js';
import { restartEditorBrowserWorker } from './support/editor-browser-worker-restart.js';
import {
  observeScheduleBeforeDue,
  scheduleEvidenceSchema,
  scheduleScopeSchema,
  verifyScheduleEvidence,
} from './support/editor-schedule-evidence.js';
import {
  prepareReadonlyEvidence,
  readonlyEvidenceSchema,
  readonlySetupSchema,
} from './support/editor-readonly-evidence.js';
import {
  expressionAdmissionEvidenceSchema,
  verifyExpressionAdmissionEvidence,
} from './support/editor-expression-admission-evidence.js';
import {
  receiptRecoveryEvidenceSchema,
  runRecoveryEvidenceSchema,
  verifyReceiptRecoveryEvidence,
  verifyRunRecoveryEvidence,
} from './support/editor-browser-recovery-evidence.js';
import {
  workflowDuplicationEvidenceSchema,
  verifyWorkflowDuplicationEvidence,
} from './support/workflow-duplication-browser-evidence.js';
import {
  workflowInputCasesEvidenceSchema,
  verifyWorkflowInputCasesEvidence,
} from './support/workflow-input-cases-browser-evidence.js';

const enabled = process.env.EDITOR_BROWSER_INTEGRATION === 'true';
const scenario = z
  .enum([
    'nested-conflict',
    'receipts',
    'run-recovery',
    'expression-admission',
    'readonly',
    'schedule',
    'webhook-controlled-http',
    'duplication',
    'input-cases',
  ])
  .parse(process.env.EDITOR_BROWSER_CASE ?? 'nested-conflict');
const webOrigin = 'http://127.0.0.1:4174';
const workerDirectory = new URL('../../worker/', import.meta.url);
const owner = new FixtureResourceOwner();
const webDirectory = new URL('../../web/', import.meta.url);
const webRequire = createRequire(new URL('package.json', webDirectory));
const browserChildren: ChildProcess[] = [];
const openBrowserInstances = new Set<string>();
let browserWasOpened = false;
const processOwners = new WeakMap<
  ChildProcess,
  ReturnType<typeof ownEditorBrowserProcess>
>();
function ownChild<T extends ChildProcess>(
  name: string,
  child: T,
  kind: 'browser' | 'vite' | 'worker',
): T {
  processOwners.set(
    child,
    ownEditorBrowserProcess(child, kind, {
      browserDisposed: () =>
        browserWasOpened && openBrowserInstances.size === 0,
    }),
  );
  return owner.acquire(name, child, closeChild);
}
let worker: ChildProcess;
const httpMaster =
  scenario === 'webhook-controlled-http' ? randomBytes(32) : undefined;
const httpAuthorization =
  scenario === 'webhook-controlled-http' ? `Bearer ${randomUUID()}` : undefined;
let httpControl: ReturnType<typeof createEditorHttpControl> | undefined;
let httpEffects: z.infer<typeof httpEffectsSchema> | undefined;
function assertHttpDependenciesDisposable(child: ChildProcess | undefined) {
  if (child === undefined) return;
  if (processOwners.get(child)?.diagnostics().stage !== 'disposed')
    throw new Error('Worker drain unconfirmed; retain HTTP dependencies');
}
const browserEvidenceSchema = z.strictObject({
  runId: z.uuid(),
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  workflowVersionId: z.uuid(),
  rootId: z.uuid(),
  outerId: z.uuid(),
  innerId: z.uuid(),
  leafId: z.uuid(),
  outsiderWorkspaceId: z.uuid(),
  conflictRevision: z.number().int().positive(),
  finalDraftRevision: z.number().int().positive(),
});
let evidence: z.infer<typeof browserEvidenceSchema> | undefined;
let duplicationEvidence:
  z.infer<typeof workflowDuplicationEvidenceSchema> | undefined;
let inputCasesEvidence:
  z.infer<typeof workflowInputCasesEvidenceSchema> | undefined;
const inputCasesRolloutEvidenceSchema = z.strictObject({
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  workflowVersionId: z.uuid(),
  runIds: z.array(z.uuid()).length(4),
});
let inputCasesRolloutEvidence:
  z.infer<typeof inputCasesRolloutEvidenceSchema> | undefined;
let receiptEvidence: z.infer<typeof receiptRecoveryEvidenceSchema> | undefined;
let runRecoveryEvidence: z.infer<typeof runRecoveryEvidenceSchema> | undefined;
let expressionEvidence:
  z.infer<typeof expressionAdmissionEvidenceSchema> | undefined;
let readonlyFixture:
  Awaited<ReturnType<typeof prepareReadonlyEvidence>> | undefined;
let readonlyEvidence: z.infer<typeof readonlyEvidenceSchema> | undefined;
let readonlySetupPending = false;
let scheduleEvidence: z.infer<typeof scheduleEvidenceSchema> | undefined;
let scheduleRestart:
  | {
      scope: z.infer<typeof scheduleScopeSchema>;
      triggerId: string;
      nextFireAt: string;
      requestId: string;
    }
  | undefined;
let scheduleRestartUsed = false;
const restartScope = new AbortController();
function assertRestartScopeActive() {
  if (restartScope.signal.aborted) throw new Error('Schedule fixture disposed');
}

function phase(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('error', failed);
      child.off('exit', exited);
      if (error === undefined) resolve();
      else reject(error);
    };
    const message = (value: unknown) => {
      if (
        typeof value === 'object' &&
        value !== null &&
        'phase' in value &&
        value.phase === expected
      )
        finish();
    };
    const failed = (error: Error) => {
      finish(error);
    };
    const exited = () => {
      finish(new Error(`Owned worker exited before ${expected}`));
    };
    const timer = setTimeout(() => {
      finish(new Error(`Owned worker did not reach ${expected}`));
    }, 15_000);
    child.on('message', message);
    child.once('error', failed);
    child.once('exit', exited);
  });
}

async function recheckOwnership(): Promise<void> {
  await verifyEditorBrowserOwnership(process.env, async (id) => {
    const { stdout } = await promisify(execFile)('docker', ['inspect', id], {
      timeout: 4_000,
      maxBuffer: 1_048_576,
    });
    return stdout;
  });
}

async function closeChild(child: ChildProcess): Promise<void> {
  const processOwner = processOwners.get(child);
  if (processOwner === undefined)
    throw new Error('Refusing disposal of an unowned process');
  try {
    await processOwner.close();
  } catch (error) {
    // Only fixed fields and allowed system codes, never raw/nested runtime errors.
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      ['ESRCH', 'EPERM', 'EINVAL'].includes(error.code)
        ? error.code
        : undefined;
    process.stderr.write(
      `Owned process cleanup diagnostic ${JSON.stringify({
        ...processOwner.diagnostics(),
        code,
      })}\n`,
    );
    throw error;
  }
}

describe.skipIf(!enabled)('real browser, API and pure-node worker', () => {
  // Refuse fallback/default database URLs and verify exact owned services before
  // acquiring Redis or allowing the ordinary migrated UUID database fixture.
  beforeAll(async () => {
    await recheckOwnership();
    if (httpMaster !== undefined && httpAuthorization !== undefined) {
      // Reverse acquisition order: worker drains first, then sender/proxy; no
      // key material or server is disposed while attempts may still dispatch.
      owner.acquire('HTTP master key', httpMaster, (key) => {
        assertHttpDependenciesDisposable(worker);
        key.fill(0);
      });
      httpControl = owner.acquire(
        'HTTP sender control',
        createEditorHttpControl(
          () => api.database(),
          httpAuthorization,
          assertRestartScopeActive,
        ),
        (control) => {
          assertHttpDependenciesDisposable(worker);
          return control.close();
        },
      );
    }
    const probe = createTcpServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(4174, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      }),
    );
    worker = ownChild(
      'pure-node worker process',
      fork('test/editor-browser-worker-process-fixture.ts', [], {
        cwd: workerDirectory,
        execArgv: ['--import', 'tsx'],
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        detached: true,
      }),
      'worker',
    );
    // Register the startup observer synchronously before the child can do work.
    worker.on('message', (value: unknown) => {
      const observation = httpEffectsSchema.safeParse(value);
      if (observation.success) {
        httpEffects = observation.data;
        return;
      }
      if (
        typeof value !== 'object' ||
        value === null ||
        !('phase' in value) ||
        value.phase !== 'namespace-cleanup-request'
      )
        return;
      void recheckOwnership().then(
        () => {
          if (worker.connected)
            worker.send({ phase: 'namespace-cleanup-approved' });
        },
        () => {
          if (worker.connected)
            worker.send({ phase: 'namespace-cleanup-denied' });
        },
      );
    });
    const ready = phase(worker, 'namespace-ready');
    worker.stderr?.pipe(process.stderr);
    await ready;
  }, 30_000);

  const redis = new URL(process.env.REDIS_URL ?? 'redis://invalid:1/0');
  redis.pathname = '/11';
  const api = useBetterAuthRealApi('editor_browser', {
    publicWebOrigin: webOrigin,
    nodeCompatibilityCohort:
      scenario === 'schedule'
        ? 'schedule_activation'
        : scenario === 'webhook-controlled-http'
          ? httpCohort
          : 'validate_activation',
    schedules: scenario === 'schedule',
    ...(httpMaster === undefined
      ? {}
      : {
          webhookRuntime: (config) =>
            createEditorWebhookRuntime(config.database, httpCohort, httpMaster),
        }),
    redisUrl: redis.toString(),
    connections: {
      config: {
        kmsKeyReference: 'unused-pure-node-fixture',
        region: 'us-east-1',
      },
      overrides: {
        // Discovery/authorization/persistence are real. This pure-node gate
        // neither provisions credentials nor permits outbound provider calls.
        encryption:
          httpMaster === undefined
            ? {
                value: {
                  seal: () =>
                    Promise.reject(
                      new Error(
                        'Credential writes are outside the pure-node gate',
                      ),
                    ),
                  open: () =>
                    Promise.reject(
                      new Error(
                        'Credential reads are outside the pure-node gate',
                      ),
                    ),
                },
              }
            : {
                factory: () => {
                  const keys =
                    createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
                      httpMaster,
                      'connection',
                    );
                  return {
                    encryption: new ConnectionEnvelopeEncryption(keys),
                    close: () => {
                      keys.close();
                    },
                  };
                },
              },
        clients: {
          http: {
            execute: () =>
              Promise.reject(
                new Error('Provider calls are outside the pure-node gate'),
              ),
          },
        },
      },
    },
    logger: createStructuredLogger({
      environment: 'test',
      serviceName: 'pertexo-editor-browser',
      serviceVersion: 'fixture',
      logLevel: 'error',
      otlpHeaders: {},
    }),
    afterMigration: async (databaseUrl) => {
      if (scenario === 'schedule' || scenario === 'webhook-controlled-http') {
        const inspector = new Pool({
          connectionString: databaseUrl(process.env.DATABASE_ADMIN_URL ?? ''),
        });
        try {
          const identity = await inspector.query<{ name: string; oid: number }>(
            'select datname as name,oid::int as oid from pg_database where datname=current_database()',
          );
          expect(identity.rows).toHaveLength(1);
          process.stdout.write(
            `Live browser ${scenario} database ${JSON.stringify(identity.rows[0])}\n`,
          );
        } finally {
          await inspector.end();
        }
      }
      const ready = phase(worker, 'worker-ready');
      worker.send({
        workerUrl: databaseUrl(process.env.DATABASE_WORKER_URL ?? ''),
        dispatcherUrl: databaseUrl(process.env.DATABASE_DISPATCHER_URL ?? ''),
        apiUrl: databaseUrl(process.env.DATABASE_API_URL ?? ''),
        migrationUrl: databaseUrl(process.env.DATABASE_MIGRATION_URL ?? ''),
        ...(httpMaster === undefined
          ? {}
          : {
              connectionMasterKey: httpMaster.toString('hex'),
              authorizationValue: httpAuthorization,
            }),
      });
      await ready;
    },
    beforeClose: async () => {
      restartScope.abort();
      // Stop before worker/lease cleanup if a browser descendant is unconfirmed.
      for (const child of browserChildren.toReversed()) await closeChild(child);
      await owner.close();
    },
    beforeDrop: recheckOwnership,
  });

  it(`executes the owned real-browser scenario: ${scenario}`, async () => {
    // Catch module omissions before launching the browser. These exercise
    // actual request guards and authorized stores, not seeded mock responses.
    const prerequisiteEmail = `prerequisite-${randomUUID()}@integration.test`;
    await api.signUp(prerequisiteEmail, '/workspaces');
    const browser = await api.signIn(prerequisiteEmail);
    const createdWorkspace = await api.send('POST', '/v1/workspaces', {
      browser,
      headers: { 'Idempotency-Key': randomUUID() },
      payload: {
        name: 'Fixture prerequisites',
        slug: `pre-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(createdWorkspace.statusCode, createdWorkspace.payload).toBe(201);
    const prerequisiteWorkspace = workspaceResponseSchema.parse(
      createdWorkspace.json(),
    );
    const workspacePath = `/v1/workspaces/${prerequisiteWorkspace.id}`;
    for (const path of [
      '/v1/users/me',
      '/v1/workspaces',
      '/v1/node-definitions',
      '/v1/integrations',
      `${workspacePath}/connections`,
      `${workspacePath}/failure-notification-destinations`,
      `${workspacePath}/workflows`,
      `${workspacePath}/runs`,
      `${workspacePath}/run-statistics`,
    ]) {
      const response = await api.send('GET', path, { browser });
      expect(response.statusCode, `${path}: ${response.payload}`).toBe(200);
    }
    const createdWorkflow = await api.send(
      'POST',
      `${workspacePath}/workflows`,
      {
        browser,
        headers: { 'Idempotency-Key': randomUUID() },
        payload: { name: 'Prerequisite' },
      },
    );
    expect(createdWorkflow.statusCode, createdWorkflow.payload).toBe(201);
    const prerequisiteWorkflow = workflowCreateResponseSchema.parse(
      createdWorkflow.json(),
    ).workflow;
    for (const path of [
      `${workspacePath}/workflows/${prerequisiteWorkflow.id}`,
      `${workspacePath}/workflows/${prerequisiteWorkflow.id}/draft`,
    ]) {
      const response = await api.send('GET', path, { browser });
      expect(response.statusCode, `${path}: ${response.payload}`).toBe(200);
    }
    const apiOrigin = await api.listen();
    httpControl?.setApiOrigin(apiOrigin);
    const readiness = await fetch(`${apiOrigin}/health/ready`);
    expect(readiness.status).toBe(200);

    // Separate loopback test-control listener for the local mail sink and
    // non-secret result IDs. This is never registered in the application API.
    const mailServer = createServer((request, response) => {
      if (httpControl?.handle(request, response) === true) return;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (
        scenario === 'input-cases' &&
        request.method === 'POST' &&
        url.pathname === '/input-cases-rollout'
      ) {
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 128) request.destroy();
        });
        request.on('end', () => {
          void (async () => {
            try {
              const { enabled: casesEnabled } = z
                .strictObject({ enabled: z.boolean() })
                .parse(JSON.parse(body) as unknown);
              await recheckOwnership();
              // Test-only operator control on the attested disposable database;
              // never a route or entitlement on the application API.
              const changed = await api
                .database()
                .query(
                  'update app.workflow_input_case_rollout set enabled=$1 where singleton',
                  [casesEnabled],
                );
              expect(changed.rowCount).toBe(1);
              response.writeHead(204).end();
            } catch {
              response.writeHead(400).end();
            }
          })();
        });
        return;
      }
      if (
        request.method === 'POST' &&
        (url.pathname === '/browser-opened' ||
          url.pathname === '/browser-disposed')
      ) {
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 128) request.destroy();
        });
        request.on('end', () => {
          try {
            const value: unknown = JSON.parse(body);
            if (
              typeof value !== 'object' ||
              value === null ||
              !('instanceId' in value) ||
              typeof value.instanceId !== 'string' ||
              !/^[a-f0-9-]{36}$/u.test(value.instanceId)
            )
              throw new Error('Invalid browser receipt');
            if (url.pathname === '/browser-opened') {
              browserWasOpened = true;
              openBrowserInstances.add(value.instanceId);
            } else if (!openBrowserInstances.delete(value.instanceId))
              throw new Error('Unknown browser receipt');
            response.writeHead(204).end();
          } catch {
            response.writeHead(400).end();
          }
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/verification') {
        try {
          const link = api.mailedLink(
            url.searchParams.get('email') ?? '',
            'verification',
          );
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ path: link.pathname + link.search }));
        } catch {
          response.writeHead(404).end();
        }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/readonly-setup') {
        if (
          scenario !== 'readonly' ||
          readonlyFixture !== undefined ||
          readonlySetupPending
        ) {
          response.writeHead(409).end();
          return;
        }
        readonlySetupPending = true;
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 1_024) request.destroy();
        });
        request.on('end', () => {
          void (async () => {
            try {
              readonlyFixture = await prepareReadonlyEvidence(
                api.database(),
                readonlySetupSchema.parse(JSON.parse(body)),
              );
              response.setHeader('content-type', 'application/json');
              response.end(JSON.stringify(readonlyFixture.scope));
            } catch {
              response.writeHead(400).end();
            } finally {
              readonlySetupPending = false;
            }
          })();
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/schedule-restart') {
        if (
          scenario !== 'schedule' ||
          scheduleRestartUsed ||
          restartScope.signal.aborted
        ) {
          response.writeHead(409).end();
          return;
        }
        scheduleRestartUsed = true;
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 1_024) request.destroy();
        });
        request.on('end', () => {
          void (async () => {
            try {
              const scope = scheduleScopeSchema.parse(JSON.parse(body));
              const before = await observeScheduleBeforeDue(
                api.database(),
                scope,
              );
              const requestId = randomUUID();
              await restartEditorBrowserWorker(
                worker,
                requestId,
                restartScope.signal,
              );
              assertRestartScopeActive();
              const after = await observeScheduleBeforeDue(
                api.database(),
                scope,
              );
              assertRestartScopeActive();
              expect({ ...after, observedAt: before.observedAt }).toEqual(
                before,
              );
              scheduleRestart = {
                scope,
                triggerId: before.triggerId,
                nextFireAt: before.nextFireAt,
                requestId,
              };
              response.setHeader('content-type', 'application/json');
              response.end(
                JSON.stringify({
                  ...scheduleRestart,
                  beforeObservedAt: before.observedAt,
                  afterObservedAt: after.observedAt,
                }),
              );
            } catch {
              response.writeHead(400).end();
            }
          })();
        });
        return;
      }
      if (
        request.method === 'POST' &&
        (url.pathname === '/evidence' ||
          url.pathname === '/evidence/receipts' ||
          url.pathname === '/evidence/run-recovery' ||
          url.pathname === '/evidence/expression-admission' ||
          url.pathname === '/evidence/duplication' ||
          url.pathname === '/input-cases-evidence' ||
          url.pathname === '/input-cases-rollout-evidence' ||
          url.pathname === '/evidence/readonly' ||
          url.pathname === '/evidence/schedule')
      ) {
        let body = '';
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > 1_024) request.destroy();
        });
        request.on('end', () => {
          try {
            const value: unknown = JSON.parse(body);
            if (url.pathname === '/evidence' && scenario === 'nested-conflict')
              evidence = browserEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/receipts' &&
              scenario === 'receipts'
            )
              receiptEvidence = receiptRecoveryEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/run-recovery' &&
              scenario === 'run-recovery'
            )
              runRecoveryEvidence = runRecoveryEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/expression-admission' &&
              scenario === 'expression-admission'
            )
              expressionEvidence =
                expressionAdmissionEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/duplication' &&
              scenario === 'duplication'
            )
              duplicationEvidence =
                workflowDuplicationEvidenceSchema.parse(value);
            else if (
              url.pathname === '/input-cases-evidence' &&
              scenario === 'input-cases'
            )
              inputCasesEvidence =
                workflowInputCasesEvidenceSchema.parse(value);
            else if (
              url.pathname === '/input-cases-rollout-evidence' &&
              scenario === 'input-cases'
            )
              inputCasesRolloutEvidence =
                inputCasesRolloutEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/readonly' &&
              scenario === 'readonly'
            )
              readonlyEvidence = readonlyEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/schedule' &&
              scenario === 'schedule'
            )
              scheduleEvidence = scheduleEvidenceSchema.parse(value);
            else
              throw new Error('Evidence does not match the selected scenario');
            response.writeHead(204).end();
          } catch {
            response.writeHead(400).end();
          }
        });
        return;
      }
      response.writeHead(404).end();
    });
    owner.acquire(
      'mail-sink control listener',
      mailServer,
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          }),
        ),
    );
    await new Promise<void>((resolve, reject) => {
      mailServer.once('error', reject);
      mailServer.listen(0, '127.0.0.1', resolve);
    });
    const address = mailServer.address();
    if (address === null || typeof address === 'string')
      throw new Error('Control listener has no TCP address');
    const childEnvironment = {
      ...process.env,
      PERTEXO_API_PROXY_TARGET: apiOrigin,
      PERTEXO_LIVE_MAIL_ORIGIN: `http://127.0.0.1:${String(address.port)}`,
    };
    const viteCli = join(
      dirname(webRequire.resolve('vite/package.json')),
      'bin/vite.js',
    );
    const startWebChild = (name: string, args: string[]) => {
      const child = ownChild(
        name,
        spawn(process.execPath, args, {
          cwd: webDirectory,
          env: childEnvironment,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        }),
        'vite',
      );
      browserChildren.push(child);
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      return child;
    };
    const exitedSuccessfully = (child: ChildProcess) =>
      new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Owned web process exited ${String(code)}`));
        });
      });
    await exitedSuccessfully(
      startWebChild('live Vite build', [viteCli, 'build']),
    );
    const preview = startWebChild('live Vite preview', [
      viteCli,
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      '4174',
      '--strictPort',
    ]);
    const previewStarted = Date.now();
    let previewReady = false;
    while (!previewReady) {
      if (preview.exitCode !== null || preview.signalCode !== null)
        throw new Error('Owned Vite preview exited during startup');
      try {
        const response = await fetch(webOrigin, {
          signal: AbortSignal.timeout(1_000),
        });
        previewReady = response.ok;
      } catch {
        /* The owned listener is not ready yet. */
      }
      if (Date.now() - previewStarted >= 15_000)
        throw new Error('Owned Vite preview did not start');
      await delay(50);
    }
    await new Promise<void>((resolve, reject) => {
      const child = ownChild(
        'live Playwright process',
        spawn(
          process.execPath,
          [
            webRequire.resolve('@playwright/test/cli'),
            'test',
            '--config',
            'playwright.live.config.ts',
            scenario === 'input-cases'
              ? 'workflow-input-cases.spec.ts'
              : scenario === 'duplication'
                ? 'workflow-duplication.spec.ts'
                : scenario === 'nested-conflict'
                  ? 'editor-execution.spec.ts'
                  : scenario === 'receipts'
                    ? 'editor-receipts.spec.ts'
                    : scenario === 'run-recovery'
                      ? 'editor-run-recovery.spec.ts'
                      : scenario === 'expression-admission'
                        ? 'editor-expression-admission.spec.ts'
                        : scenario === 'readonly'
                          ? 'editor-readonly.spec.ts'
                          : scenario === 'schedule'
                            ? 'editor-schedule.spec.ts'
                            : 'editor-webhook-controlled-http.spec.ts',
          ],
          {
            cwd: webDirectory,
            env: childEnvironment,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
          },
        ),
        'browser',
      );
      browserChildren.push(child);
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Real browser journey exited ${String(code)}`));
      });
    });
    if (scenario === 'input-cases') {
      if (inputCasesEvidence === undefined)
        throw new Error('Workflow input cases evidence missing');
      await verifyWorkflowInputCasesEvidence(
        api.database(),
        inputCasesEvidence,
      );
      if (inputCasesRolloutEvidence === undefined)
        throw new Error(
          'Default-off and rollback ordinary run evidence missing',
        );
      expect(new Set(inputCasesRolloutEvidence.runIds).size).toBe(4);
      const ordinaryRuns = await api.database().query<{
        id: string;
        workflow_version_id: string;
        status: string;
        input_ref: unknown;
      }>('select id,workflow_version_id,status,input_ref from app.workflow_runs where workspace_id=$1 and workflow_id=$2 order by id', [inputCasesRolloutEvidence.workspaceId, inputCasesRolloutEvidence.workflowId]);
      expect(ordinaryRuns.rows).toHaveLength(4);
      expect(ordinaryRuns.rows.map((run) => run.id).sort()).toEqual(
        [...inputCasesRolloutEvidence.runIds].sort(),
      );
      for (const run of ordinaryRuns.rows)
        expect(run).toMatchObject({
          workflow_version_id: inputCasesRolloutEvidence.workflowVersionId,
          status: 'succeeded',
          input_ref: { kind: 'inline', value: { proof: 'f02-unchecked' } },
        });
      expect(
        (
          await api
            .database()
            .query<{ enabled: boolean }>(
              'select enabled from app.workflow_input_case_rollout where singleton',
            )
        ).rows,
      ).toEqual([{ enabled: false }]);
      process.stdout.write(
        `Live browser workflow input cases verified identities ${JSON.stringify(inputCasesEvidence)}\n`,
      );
      process.stdout.write(
        `Live browser default-off and rollback ordinary runs verified identities ${JSON.stringify(inputCasesRolloutEvidence)}\n`,
      );
      return;
    }
    if (scenario === 'duplication') {
      if (duplicationEvidence === undefined)
        throw new Error('Workflow duplication evidence missing');
      await verifyWorkflowDuplicationEvidence(
        api.database(),
        duplicationEvidence,
      );
      process.stdout.write(
        `Live browser workflow duplication evidence ${JSON.stringify(duplicationEvidence)}\n`,
      );
      return;
    }
    if (scenario === 'webhook-controlled-http') {
      if (httpControl === undefined || httpEffects === undefined)
        throw new Error('Owned HTTP control/effect evidence missing');
      const submitted = httpControl.readEvidence();
      process.stdout.write(
        `Live browser controlled HTTP submitted/unverified identities ${JSON.stringify(submittedHttpEvidenceIds(submitted))}\n`,
      );
      await verifyHttpEvidence(api.database(), submitted, httpEffects);
      process.stdout.write(
        `Live browser controlled HTTP verified evidence ${JSON.stringify({ ...submitted, effects: httpEffects })}\n`,
      );
      return;
    }
    if (scenario === 'schedule') {
      if (scheduleEvidence === undefined || scheduleRestart === undefined)
        throw new Error('Schedule restart/evidence missing');
      expect(scheduleRestart.scope).toEqual({
        workspaceId: scheduleEvidence.workspaceId,
        workflowId: scheduleEvidence.workflowId,
        workflowVersionId: scheduleEvidence.workflowVersionId,
      });
      expect(scheduleEvidence.triggerId).toBe(scheduleRestart.triggerId);
      expect(scheduleEvidence.firstDueAt).toBe(scheduleRestart.nextFireAt);
      process.stdout.write(
        `Live browser schedule submitted/unverified ${JSON.stringify({
          workspaceId: scheduleEvidence.workspaceId,
          workflowId: scheduleEvidence.workflowId,
          workflowVersionId: scheduleEvidence.workflowVersionId,
          triggerId: scheduleEvidence.triggerId,
          runId: scheduleEvidence.runId,
          occurrenceId: scheduleEvidence.occurrenceId,
          restartRequestId: scheduleRestart.requestId,
          firstDueAt: scheduleEvidence.firstDueAt,
          scheduledAt: scheduleEvidence.scheduledAt,
        })}\n`,
      );
      await verifyScheduleEvidence(api.database(), scheduleEvidence);
      process.stdout.write(
        `Live browser schedule evidence ${JSON.stringify({ ...scheduleEvidence, restartRequestId: scheduleRestart.requestId })}\n`,
      );
      return;
    }
    if (scenario === 'readonly') {
      if (readonlyFixture === undefined || readonlyEvidence === undefined)
        throw new Error('Readonly editor evidence missing');
      await readonlyFixture.verify(readonlyEvidence);
      process.stdout.write(
        `Live browser readonly evidence ${JSON.stringify(readonlyEvidence)}\n`,
      );
      return;
    }
    if (scenario === 'expression-admission') {
      if (expressionEvidence === undefined)
        throw new Error('Expression admission evidence missing');
      await verifyExpressionAdmissionEvidence(
        api.database(),
        expressionEvidence,
      );
      process.stdout.write(
        `Live browser expression admission ${JSON.stringify(expressionEvidence)}\n`,
      );
      return;
    }
    if (scenario === 'receipts') {
      if (receiptEvidence === undefined)
        throw new Error('Receipt recovery evidence missing');
      await verifyReceiptRecoveryEvidence(api.database(), receiptEvidence);
      process.stdout.write(
        `Live browser receipt recovery ${JSON.stringify(receiptEvidence)}\n`,
      );
      return;
    }
    if (scenario === 'run-recovery') {
      if (runRecoveryEvidence === undefined)
        throw new Error('Run recovery evidence missing');
      await verifyRunRecoveryEvidence(api.database(), runRecoveryEvidence);
      process.stdout.write(
        `Live browser run recovery ${JSON.stringify(runRecoveryEvidence)}\n`,
      );
      return;
    }
    expect(evidence).toBeDefined();
    const persisted = await api.database().query<{
      status: string;
      workflow_id: string;
      workspace_id: string;
      workflow_version_id: string;
    }>('select status, workflow_id, workspace_id, workflow_version_id from app.workflow_runs where id=$1', [evidence?.runId]);
    expect(persisted.rows).toEqual([
      {
        status: 'succeeded',
        workflow_id: evidence?.workflowId,
        workspace_id: evidence?.workspaceId,
        workflow_version_id: evidence?.workflowVersionId,
      },
    ]);
    const nodes = await api.database().query<{
      node_id: string;
      status: string;
      invocation_key: string;
      branch_context: unknown;
    }>(
      `select node_id,status,invocation_key,branch_context from app.node_runs
       where workflow_run_id=$1 and workspace_id=$2`,
      [evidence?.runId, evidence?.workspaceId],
    );
    expect(nodes.rows).toHaveLength(8);
    expect(nodes.rows.every((node) => node.status === 'succeeded')).toBe(true);
    const leaves = nodes.rows.filter(
      (node) => node.node_id === evidence?.leafId,
    );
    expect(leaves).toHaveLength(4);
    expect(new Set(leaves.map((node) => node.invocation_key)).size).toBe(4);
    expect(leaves.map((node) => node.branch_context)).toEqual(
      expect.arrayContaining(
        [0, 1].flatMap((outer) =>
          [0, 1].map((inner) => ({
            branchPath: [],
            iterationPath: [
              { loopNodeId: evidence?.outerId, ordinal: outer },
              { loopNodeId: evidence?.innerId, ordinal: inner },
            ],
          })),
        ),
      ),
    );
    expect(
      nodes.rows.filter((node) => node.node_id === evidence?.innerId),
    ).toHaveLength(2);
    const draft = await api
      .database()
      .query<{ revision: number; graph_json: unknown }>(
        'select revision,graph_json from app.workflow_drafts where workflow_id=$1 and workspace_id=$2',
        [evidence?.workflowId, evidence?.workspaceId],
      );
    expect(draft.rows).toHaveLength(1);
    expect(draft.rows[0]?.revision).toBe(evidence?.finalDraftRevision);
    expect(evidence?.finalDraftRevision).toBeGreaterThan(
      evidence?.conflictRevision ?? 0,
    );
    const draftRoot = workflowGraphSchema
      .parse(draft.rows[0]?.graph_json)
      .nodes.find((node) => node.id === evidence?.rootId);
    expect(draftRoot).toMatchObject({
      label: 'Local source choice',
      inputMappings: {
        literalProof: { kind: 'literal', value: 'unpublished-after-run' },
      },
    });
    const versions = await api
      .database()
      .query<{ id: string; graph_json: unknown }>(
        'select id,graph_json from app.workflow_versions where workflow_id=$1 and workspace_id=$2',
        [evidence?.workflowId, evidence?.workspaceId],
      );
    expect(versions.rows).toHaveLength(1);
    expect(versions.rows[0]?.id).toBe(evidence?.workflowVersionId);
    expect(
      workflowGraphSchema
        .parse(versions.rows[0]?.graph_json)
        .nodes.find((node) => node.id === evidence?.rootId),
    ).toMatchObject({
      label: 'Mapping source',
      inputMappings: {
        literalProof: { kind: 'literal', value: 'from-real-browser' },
      },
    });
    const counts = await api
      .database()
      .query<{ count: number }>(
        'select count(*)::int as count from app.workflow_runs where workflow_id=$1 and workspace_id=$2',
        [evidence?.workflowId, evidence?.workspaceId],
      );
    expect(counts.rows).toEqual([{ count: 1 }]);
    process.stdout.write(
      `Live browser durable evidence ${JSON.stringify(evidence)}\n`,
    );
  }, 180_000);
});
