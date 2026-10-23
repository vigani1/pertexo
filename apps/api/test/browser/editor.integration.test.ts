import { verifyCallbackEvidence } from './editor/evidence/callbacks/verify.js';
import { createCallbackTokenKeys } from '@pertexo/integrations/server';
import { createBrowserOidcProvider } from './editor/federation/oidc-provider.js';
import * as oidcProtocol from '../../src/authentication/federation/protocol/oidc.js';
import { Resolver } from 'node:dns/promises';
import { createBrowserIdentityProvider } from './editor/federation/provider.js';
import { useSocialProviderGateway } from '../support/better-auth/social-provider.js';
import { verifyCodeEvidence } from './editor/evidence/code/verify.js';
import { verifyWebhookResponseEvidence } from './editor/evidence/webhook-responses.js';
import { verifySampleEvidence } from './editor/evidence/samples/verify.js';
import { verifyNotificationEvidence } from './editor/evidence/notifications/verify.js';
import { verifyVariableEvidence } from './editor/evidence/variables/verify.js';
import { verifyFormEvidence } from './editor/evidence/forms/verify.js';
import { verifyApprovalEvidence } from './editor/evidence/approvals/verify.js';
import { verifyErrorWorkflowEvidence } from './editor/evidence/error-workflows/verify.js';
import {
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store';
import {
  collectionEvidenceSchema,
  dateEvidenceSchema,
  verifyTransformEvidence,
} from './editor/evidence/transforms/qualification.js';
import {
  apiTokensEvidenceSchema,
  verifyApiTokensEvidence,
} from './editor/evidence/api-tokens/qualification.js';
import {
  failureRoutingEvidenceSchema,
  verifyFailureRoutingEvidence,
} from './editor/evidence/failure-routing.js';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Pool } from 'pg';
import {
  ConnectionEnvelopeEncryption,
  type ConnectionSecretContext,
} from '@pertexo/integrations/server';
import { createEditorBrowserEnvelopeKeys } from '../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import { createCuratedTemplateEnvelopeContext } from '../../../../infrastructure/testing/curated-template-envelope-context.mjs';
import { createEditorWebhookRuntime } from './editor/webhook-runtime.js';
import { createEditorHttpControl } from './editor/http-control.js';
import {
  callsEvidenceSchema,
  verifyCallsEvidence,
} from './editor/evidence/calls.js';
import {
  callableEvidenceSchema,
  verifyCallableEvidence,
} from './editor/evidence/callable.js';
import {
  httpEffectsSchema,
  submittedHttpEvidenceIds,
  verifyHttpEvidence,
} from './editor/evidence/http.js';
import { createStructuredLogger } from '@pertexo/observability';
import {
  workspaceResponseSchema,
  workflowCreateResponseSchema,
  workflowGraphSchema,
} from '@pertexo/contracts';
import { FixtureResourceOwner } from './harness/resource-owner.js';
import { useBetterAuthRealApi } from '../support/better-auth/real-api.support.js';
import { ownEditorBrowserProcess } from './harness/process.js';
import { verifyEditorBrowserOwnership } from './harness/ownership.js';
import { restartEditorBrowserWorker } from './harness/worker-restart.js';
import {
  observeScheduleBeforeDue,
  scheduleEvidenceSchema,
  scheduleScopeSchema,
  verifyScheduleEvidence,
} from './editor/evidence/schedule.js';
import {
  prepareReadonlyEvidence,
  readonlyEvidenceSchema,
  readonlySetupSchema,
} from './editor/evidence/readonly.js';
import {
  expressionAdmissionEvidenceSchema,
  verifyExpressionAdmissionEvidence,
} from './editor/evidence/expression-admission.js';
import {
  receiptRecoveryEvidenceSchema,
  runRecoveryEvidenceSchema,
  verifyReceiptRecoveryEvidence,
  verifyRunRecoveryEvidence,
} from './editor/evidence/recovery.js';
import {
  workflowDuplicationEvidenceSchema,
  verifyWorkflowDuplicationEvidence,
} from './editor/evidence/duplication.js';
import {
  prepareWorkflowPortabilityBrowserFixture,
  workflowPortabilityBrowserEvidenceSchema,
  verifyWorkflowPortabilityBrowserEvidence,
} from './editor/portability.fixture.js';
import {
  workflowInputCasesEvidenceSchema,
  verifyWorkflowInputCasesEvidence,
} from './editor/evidence/input-cases.js';
import {
  prepareCuratedTemplateBrowserFixture,
  curatedTemplateBrowserEvidenceSchema,
} from './curated-templates/fixture.js';
import { curatedTemplateEffectsSchema } from './curated-templates/worker-evidence.js';

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
    'failure-routing',
    'error-workflows',
    'approvals',
    'forms',
    'variables',
    'run-values',
    'governance',
    'promotion',
    'collaboration',
    'federation',
    'two-factor',
    'http-pagination',
    'organization-oidc',
    'notifications',
    'transforms',
    'artifact-inputs',
    'api-tokens',
    'duplication',
    'portability',
    'input-cases',
    'code',
    'pinned-samples',
    'webhook-responses',
    'curated-templates',
    'callable',
  ])
  .parse(process.env.EDITOR_BROWSER_CASE ?? 'nested-conflict');
const webOrigin = 'http://127.0.0.1:4174';
const callbackConfig = {
  origin: webOrigin,
  keys: {
    current: { version: '1', key: Buffer.alloc(32, 71).toString('base64url') },
    previous: [],
  },
};

const workerDirectory = new URL('../../../worker/', import.meta.url);
const owner = new FixtureResourceOwner();
const webDirectory = new URL('../../../web/', import.meta.url);
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
let collectionEvidence: z.infer<typeof collectionEvidenceSchema> | undefined;
let dateEvidence: z.infer<typeof dateEvidenceSchema> | undefined;
let apiTokensEvidence: z.infer<typeof apiTokensEvidenceSchema> | undefined;
const noticeMailKey =
  scenario === 'notifications' ? randomBytes(32).toString('base64') : undefined;
const noticeMessages: string[] = [];
let worker: ChildProcess;
const controlledHttpScenario =
  scenario === 'webhook-controlled-http' ||
  scenario === 'failure-routing' ||
  scenario === 'artifact-inputs' ||
  scenario === 'http-pagination';
let failureRoutingEvidence:
  z.infer<typeof failureRoutingEvidenceSchema> | undefined;
const httpMaster =
  controlledHttpScenario ||
  scenario === 'curated-templates' ||
  scenario === 'webhook-responses'
    ? randomBytes(32)
    : undefined;
let httpAuthorization;
if (controlledHttpScenario) {
  if (scenario === 'artifact-inputs') {
    httpAuthorization = 'Bearer owned-artifact-destination';
  } else {
    httpAuthorization = `Bearer ${randomUUID()}`;
  }
} else {
  httpAuthorization = undefined;
}
let httpControl: ReturnType<typeof createEditorHttpControl> | undefined;
let httpEffects: z.infer<typeof httpEffectsSchema> | undefined;
let curatedEffects: z.infer<typeof curatedTemplateEffectsSchema> | undefined;
let curatedFixture:
  Awaited<ReturnType<typeof prepareCuratedTemplateBrowserFixture>> | undefined;
let curatedEvidence:
  z.infer<typeof curatedTemplateBrowserEvidenceSchema> | undefined;
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
let portabilityFixture:
  | Awaited<ReturnType<typeof prepareWorkflowPortabilityBrowserFixture>>
  | undefined;
let portabilityEvidence:
  z.infer<typeof workflowPortabilityBrowserEvidenceSchema> | undefined;
let inputCasesEvidence:
  z.infer<typeof workflowInputCasesEvidenceSchema> | undefined;
let callsEvidence: z.infer<typeof callsEvidenceSchema> | undefined;
let callableEvidence: z.infer<typeof callableEvidenceSchema> | undefined;
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
    if (scenario === 'curated-templates' && httpMaster !== undefined)
      owner.acquire('curated synthetic master key', httpMaster, (key) => {
        assertHttpDependenciesDisposable(worker);
        key.fill(0);
      });
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
      fork('test/support/editor-browser/worker-process.fixture.ts', [], {
        cwd: workerDirectory,
        execArgv: ['--import', 'tsx'],
        env: {
          ...process.env,
          ...(noticeMailKey === undefined
            ? {}
            : {
                EDITOR_BROWSER_NOTICE_MAIL_KEY: noticeMailKey,
                EDITOR_BROWSER_NOTICE_PUBLIC_ORIGIN: webOrigin,
              }),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        detached: true,
      }),
      'worker',
    );
    // Register the startup observer synchronously before the child can do work.
    worker.on('message', (value: unknown) => {
      if (
        typeof value === 'object' &&
        value !== null &&
        'phase' in value &&
        value.phase === 'notice-mail' &&
        scenario === 'notifications'
      ) {
        const parsed = z
          .object({
            phase: z.literal('notice-mail'),
            text: z.string().max(32768),
          })
          .strict()
          .parse(value);
        noticeMessages.push(parsed.text);
        return;
      }
      const curatedObservation = curatedTemplateEffectsSchema.safeParse(value);
      if (curatedObservation.success) {
        curatedEffects = curatedObservation.data;
        return;
      }
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
  let oidcProvider:
    Awaited<ReturnType<typeof createBrowserOidcProvider>> | undefined;
  if (scenario === 'organization-oidc') {
    beforeAll(async () => {
      oidcProvider = owner.acquire(
        'organization identity provider',
        await createBrowserOidcProvider(),
        (provider) => provider.close(),
      );
      const createGateway = oidcProtocol.createOidcProofGateway;
      const spy = vi
        .spyOn(oidcProtocol, 'createOidcProofGateway')
        .mockImplementation((input) => {
          if (oidcProvider === undefined) throw new Error('Owned IdP missing');
          return createGateway({ ...input, http: oidcProvider.http });
        });
      owner.acquire('organization protocol fixture', spy, (value) => {
        value.mockRestore();
      });
    });
  }
  const identityProvider = createBrowserIdentityProvider();
  if (scenario === 'federation')
    useSocialProviderGateway(identityProvider.gateway);
  const api = useBetterAuthRealApi('editor_browser', {
    ...(scenario === 'approvals' ? { callbacks: callbackConfig } : {}),
    ...(scenario === 'federation' || scenario === 'organization-oidc'
      ? {
          federationEncryption: {
            current: {
              version: 'browser-federation-v1',
              key: Buffer.alloc(32, 0x57).toString('base64'),
            },
            previous: [],
          },
          socialProviders: {
            google: {
              clientId: 'browser-fixture',
              clientSecret: 'browser-fixture',
            },
            github: {
              clientId: 'browser-fixture',
              clientSecret: 'browser-fixture',
            },
            apple: {
              clientId: 'browser-fixture',
              clientSecret: 'browser-fixture',
            },
          },
        }
      : {}),
    publicWebOrigin: webOrigin,
    automationTokens: scenario === 'api-tokens',
    notifications: [
      'forms',
      'approvals',
      'variables',
      'notifications',
      'collaboration',
    ].includes(scenario),
    ...(noticeMailKey === undefined
      ? {}
      : {
          notificationMail: {
            fromEmail: 'security@example.test',
            encryption: {
              current: { version: 'notice-browser-v1', key: noticeMailKey },
              previous: [],
            },
          },
        }),
    ...(scenario === 'artifact-inputs'
      ? { artifacts: parseArtifactStoreConfig() }
      : {}),
    schedules: scenario === 'schedule' || scenario === 'curated-templates',
    ...(httpMaster === undefined
      ? {}
      : {
          webhookRuntime: (config) =>
            createEditorWebhookRuntime(config.database, httpMaster),
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
                    scenario === 'curated-templates'
                      ? createCuratedTemplateEnvelopeContext<ConnectionSecretContext>(
                          httpMaster.toString('hex'),
                        )
                      : createEditorBrowserEnvelopeKeys<ConnectionSecretContext>(
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
      if (scenario === 'schedule' || controlledHttpScenario) {
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
        ...(scenario === 'approvals' ? { callbackConfig } : {}),
        workerUrl: databaseUrl(process.env.DATABASE_URL ?? ''),
        dispatcherUrl: databaseUrl(process.env.DATABASE_MAINTENANCE_URL ?? ''),
        apiUrl: databaseUrl(process.env.DATABASE_URL ?? ''),
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
      if (scenario === 'artifact-inputs') {
        const rows = await api
          .database()
          .query<{ workspace_id: string; id: string }>(
            'select workspace_id,id from app.artifacts',
          );
        const store = createArtifactStore(parseArtifactStoreConfig());
        try {
          for (const artifact of rows.rows)
            await store.delete({
              workspaceId: artifact.workspace_id,
              artifactId: artifact.id,
            });
        } finally {
          store.close();
        }
      }
    },
    beforeDrop: recheckOwnership,
  });

  if (scenario === 'organization-oidc')
    beforeAll(() => {
      const spy = vi
        .spyOn(Resolver.prototype, 'resolveTxt')
        .mockImplementation(async (hostname) => {
          const result = await api
            .database()
            .query<{ challenge: string }>(
              'select challenge from app.auth_domains where domain=$1 and challenge is not null',
              [hostname.replace(/^_pertexo\./u, '')],
            );
          return result.rows.map((row) => [
            `pertexo-verification=${row.challenge}`,
          ]);
        });
      owner.acquire('organization DNS fixture', spy, (value) => {
        value.mockRestore();
      });
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
    if (scenario === 'portability')
      portabilityFixture = await prepareWorkflowPortabilityBrowserFixture(
        api,
        webOrigin,
      );
    if (scenario === 'curated-templates')
      curatedFixture = await prepareCuratedTemplateBrowserFixture(
        api,
        webOrigin,
        recheckOwnership,
      );
    httpControl?.setApiOrigin(apiOrigin);
    const readiness = await fetch(`${apiOrigin}/health/ready`);
    expect(readiness.status).toBe(200);

    // Separate loopback test-control listener for the local mail sink and
    // non-secret result IDs. This is never registered in the application API.
    const mailServer = createServer((request, response) => {
      if (
        scenario === 'federation' &&
        identityProvider.handle(request, response)
      )
        return;
      if (httpControl?.handle(request, response) === true) return;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (
        scenario === 'approvals' &&
        request.method === 'POST' &&
        url.pathname === '/callback-resume'
      ) {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            if (!(chunk instanceof Uint8Array))
              throw new Error('Invalid callback fixture bytes');
            chunks.push(Buffer.from(chunk));
            if (chunks.reduce((sum, value) => sum + value.byteLength, 0) > 1024)
              throw new Error('Callback fixture command too large');
          }
          const input = z
            .object({ workspaceId: z.uuid(), runId: z.uuid() })
            .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          const found = await api
            .database()
            .query<{ id: string; callback_key_version: string }>(
              "select task.id,task.callback_key_version from app.pending_run_tasks task join app.workflow_runs run on run.workspace_id=task.workspace_id and run.id=task.run_id where task.workspace_id=$1 and task.run_id=$2 and task.kind='callback' and task.status='pending' and run.trigger_type='test'",
              [input.workspaceId, input.runId],
            );
          const task = found.rows[0];
          if (task === undefined)
            throw new Error('No owned pending test callback');
          const keys = createCallbackTokenKeys(callbackConfig);
          try {
            const token = keys.material(task, task.callback_key_version).token;
            const accepted = await fetch(`${apiOrigin}/hooks/${token}/resume`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ completed: 'callback-browser-proof' }),
            });
            if (accepted.status !== 202)
              throw new Error('Callback fixture refused');
            response.writeHead(204);
            response.end();
          } finally {
            keys.close();
          }
        })().catch(() => {
          response.writeHead(500);
          response.end('Callback qualification failed');
        });
        return;
      }

      if (
        scenario === 'organization-oidc' &&
        request.method === 'GET' &&
        url.pathname === '/organization-provider' &&
        oidcProvider !== undefined
      ) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ issuer: oidcProvider.origin }));
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/curated-template-seed' &&
        scenario === 'curated-templates' &&
        curatedFixture !== undefined
      ) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(curatedFixture.scope));
        return;
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/workflow-portability-seed' &&
        scenario === 'portability' &&
        portabilityFixture !== undefined
      ) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(portabilityFixture.scope));
        return;
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/workflow-portability-deny' &&
        scenario === 'portability' &&
        portabilityFixture !== undefined
      ) {
        void portabilityFixture.deny().then(
          () => response.writeHead(204).end(),
          () => response.writeHead(400).end(),
        );
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
          !['readonly', 'approvals', 'governance', 'collaboration'].includes(
            scenario,
          ) ||
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
        (url.pathname === '/evidence/api-tokens' ||
          url.pathname === '/evidence/transforms' ||
          url.pathname === '/evidence/transform-date' ||
          url.pathname === '/evidence' ||
          url.pathname === '/evidence/receipts' ||
          url.pathname === '/evidence/run-recovery' ||
          url.pathname === '/evidence/failure-routing' ||
          url.pathname === '/evidence/expression-admission' ||
          url.pathname === '/evidence/duplication' ||
          url.pathname === '/evidence/portability' ||
          url.pathname === '/evidence/curated-templates' ||
          url.pathname === '/input-cases-evidence' ||
          url.pathname === '/evidence/callable' ||
          url.pathname === '/evidence/calls' ||
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
            if (
              url.pathname === '/evidence/api-tokens' &&
              scenario === 'api-tokens'
            )
              apiTokensEvidence = apiTokensEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/transforms' &&
              scenario === 'transforms'
            )
              collectionEvidence = collectionEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/transform-date' &&
              scenario === 'transforms'
            )
              dateEvidence = dateEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/callable' &&
              scenario === 'callable'
            )
              callableEvidence = callableEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/calls' &&
              scenario === 'callable'
            )
              callsEvidence = callsEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/curated-templates' &&
              scenario === 'curated-templates'
            )
              curatedEvidence =
                curatedTemplateBrowserEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/portability' &&
              scenario === 'portability'
            )
              portabilityEvidence =
                workflowPortabilityBrowserEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence' &&
              scenario === 'nested-conflict'
            )
              evidence = browserEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/receipts' &&
              scenario === 'receipts'
            )
              receiptEvidence = receiptRecoveryEvidenceSchema.parse(value);
            else if (
              url.pathname === '/evidence/failure-routing' &&
              scenario === 'failure-routing'
            )
              failureRoutingEvidence =
                failureRoutingEvidenceSchema.parse(value);
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
      if (
        request.method === 'GET' &&
        url.pathname === '/notice-mail' &&
        scenario === 'notifications'
      ) {
        response
          .writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          })
          .end(JSON.stringify({ messages: noticeMessages }));
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
    identityProvider.setOrigin(`http://localhost:${String(address.port)}`);
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
          // Vitest's NODE_ENV=test must not select React's development runtime.
          env: { ...childEnvironment, NODE_ENV: 'production' },
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
            scenario === 'run-values'
              ? 'editor/run-values/journey.spec.ts'
              : scenario === 'http-pagination'
                ? 'editor/http-pagination.spec.ts'
                : scenario === 'federation' || scenario === 'two-factor'
                  ? scenario === 'two-factor'
                    ? 'authentication/two-factor.spec.ts'
                    : 'editor/federation/sign-in.spec.ts'
                  : scenario === 'organization-oidc'
                    ? 'editor/federation/organization.spec.ts'
                    : scenario === 'collaboration'
                      ? 'editor/collaboration'
                      : scenario === 'promotion'
                        ? 'editor/promotions'
                        : scenario === 'governance'
                          ? 'editor/governance'
                          : scenario === 'code'
                            ? 'editor/code.spec.ts'
                            : scenario === 'webhook-responses'
                              ? 'editor/webhook-responses.spec.ts'
                              : scenario === 'pinned-samples'
                                ? 'editor/pinned-samples.spec.ts'
                                : scenario === 'notifications'
                                  ? 'editor/notifications/attention.spec.ts'
                                  : scenario === 'variables'
                                    ? 'editor/variables/snapshots.spec.ts'
                                    : scenario === 'forms'
                                      ? 'editor/forms/submission.spec.ts'
                                      : scenario === 'approvals'
                                        ? 'editor/approvals.spec.ts'
                                        : scenario === 'error-workflows'
                                          ? 'editor/error-workflows.spec.ts'
                                          : scenario === 'artifact-inputs'
                                            ? process.env
                                                .F45_RELEASE_QUALIFICATION ===
                                              'true'
                                              ? 'editor/files/maximum-upload.spec.ts'
                                              : 'editor/files/'
                                            : scenario === 'api-tokens'
                                              ? 'api-tokens.spec.ts'
                                              : scenario === 'callable'
                                                ? 'editor/callable.spec.ts'
                                                : scenario ===
                                                    'curated-templates'
                                                  ? 'curated-templates.spec.ts'
                                                  : scenario === 'portability'
                                                    ? 'workflow-portability.spec.ts'
                                                    : scenario === 'input-cases'
                                                      ? 'workflow-input-cases.spec.ts'
                                                      : scenario ===
                                                          'duplication'
                                                        ? 'workflow-duplication.spec.ts'
                                                        : scenario ===
                                                            'nested-conflict'
                                                          ? 'editor/execution.spec.ts'
                                                          : scenario ===
                                                              'receipts'
                                                            ? 'editor/receipts.spec.ts'
                                                            : scenario ===
                                                                'run-recovery'
                                                              ? 'editor/run-recovery.spec.ts'
                                                              : scenario ===
                                                                  'expression-admission'
                                                                ? 'editor/expression-admission.spec.ts'
                                                                : scenario ===
                                                                    'readonly'
                                                                  ? 'editor/readonly.spec.ts'
                                                                  : scenario ===
                                                                      'schedule'
                                                                    ? 'editor/schedule.spec.ts'
                                                                    : scenario ===
                                                                        'failure-routing'
                                                                      ? 'editor/failure-routing.spec.ts'
                                                                      : scenario ===
                                                                          'transforms'
                                                                        ? 'editor/transforms.spec.ts'
                                                                        : 'editor/webhook-controlled-http.spec.ts',
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
    if (scenario === 'organization-oidc') {
      expect(
        (await api.database().query('select 1 from app.auth_provider_checks'))
          .rowCount,
      ).toBe(2);
      expect(
        (
          await api
            .database()
            .query(
              'select 1 from app.auth_accounts where access_token is not null or refresh_token is not null or id_token is not null',
            )
        ).rowCount,
      ).toBe(0);
      return;
    }
    if (scenario === 'run-values') {
      const rows = await api
        .database()
        .query<{ key: string; value: string }>(
          'select key,value from app.workflow_run_values order by key',
        );
      expect(rows.rows).toEqual([{ key: 'orderId', value: 'A-1042' }]);
      return;
    }
    if (scenario === 'two-factor' || scenario === 'http-pagination') return;
    if (scenario === 'federation') {
      const providers = await api
        .database()
        .query<{ count: number; token_count: number }>(
          "select count(*)::int count,count(*) filter(where access_token is not null or refresh_token is not null or id_token is not null)::int token_count from app.auth_accounts where provider_id in ('google','github','apple')",
        );
      expect(providers.rows).toEqual([{ count: 6, token_count: 0 }]);
      const attempts = await api
        .database()
        .query<{ count: number }>(
          'select count(*)::int count from app.auth_sign_in_attempts where consumed_at is not null',
        );
      expect(attempts.rows[0]?.count).toBe(6);
      return;
    }
    if (scenario === 'code') {
      await verifyCodeEvidence(api.database());
      return;
    }
    if (scenario === 'webhook-responses') {
      await verifyWebhookResponseEvidence(api.database());
      return;
    }
    if (scenario === 'pinned-samples') {
      await verifySampleEvidence(api.database());
      return;
    }
    if (scenario === 'notifications') {
      await verifyNotificationEvidence(api.database(), noticeMessages);
      return;
    }
    if (scenario === 'collaboration') {
      const rows = await api
        .database()
        .query<{ comments: number; mentions: number }>(
          'select (select count(*)::int from app.workflow_comments) comments,(select count(*)::int from app.workflow_comment_mentions) mentions',
        );
      expect(rows.rows[0]?.comments).toBeGreaterThanOrEqual(2);
      expect(rows.rows[0]?.mentions).toBeGreaterThanOrEqual(1);
      return;
    }
    if (scenario === 'promotion') {
      const rows = await api
        .database()
        .query<{ origins: number; versions: number }>(
          `select (select count(*)::int from app.workflow_promotion_origins) origins,(select count(*)::int from app.workflow_version_promotions) versions`,
        );
      expect(rows.rows[0]).toEqual({ origins: 2, versions: 2 });
      return;
    }
    if (scenario === 'governance') {
      const rows = await api
        .database()
        .query<{ count: number }>(
          "select count(*)::int count from app.audit_events where action='workspace.governance_changed' and metadata->>'auditRetentionDays'='30'",
        );
      expect(rows.rows[0]?.count).toBe(2);
      return;
    }
    if (scenario === 'variables') {
      await verifyVariableEvidence(api.database());
      return;
    }
    if (scenario === 'forms') {
      await verifyFormEvidence(api.database());
      return;
    }
    if (scenario === 'approvals') {
      await verifyApprovalEvidence(api.database());
      await verifyCallbackEvidence(api.database());
      return;
    }
    if (scenario === 'error-workflows') {
      await verifyErrorWorkflowEvidence(api.database());
      return;
    }
    if (scenario === 'api-tokens') {
      if (apiTokensEvidence === undefined)
        throw new Error('API token browser evidence missing');
      await verifyApiTokensEvidence(api.database(), apiTokensEvidence);
      return;
    }
    if (scenario === 'callable') {
      if (callableEvidence === undefined)
        throw new Error('Callable browser evidence missing');
      await verifyCallableEvidence(api.database(), callableEvidence);
      if (callsEvidence === undefined)
        throw new Error('Workflow Call browser evidence missing');
      await verifyCallsEvidence(api.database(), callsEvidence);
      process.stdout.write(
        `Live browser callable verified identities ${JSON.stringify(callableEvidence)}\n`,
      );
      return;
    }
    if (scenario === 'curated-templates') {
      if (curatedFixture === undefined || curatedEvidence === undefined)
        throw new Error('Curated template browser evidence missing');
      await curatedFixture.verifyEvidence(curatedEvidence);
      await recheckOwnership();
      const runs = await curatedFixture.executeGraphs(curatedEvidence);
      await recheckOwnership();
      const triggerRuns = await curatedFixture.executeTriggers(
        curatedEvidence,
        apiOrigin,
      );
      await closeChild(worker);
      if (curatedEffects === undefined)
        throw new Error('Controlled curated worker effects missing');
      expect(
        curatedEffects.observations.map(({ kind, status }) => ({
          kind,
          status,
        })),
      ).toEqual([
        { kind: 'http', status: 200 },
        { kind: 'slack', status: 200 },
        { kind: 'http', status: 204 },
        { kind: 'http', status: 500 },
      ]);
      expect(curatedEffects.pendingHttpResponses).toBe(0);
      process.stdout.write(
        `Live browser curated template verified identities ${JSON.stringify({ ...curatedEvidence, runs, triggerRuns, effects: curatedEffects })}\n`,
      );
      return;
    }
    if (scenario === 'portability') {
      if (portabilityFixture === undefined || portabilityEvidence === undefined)
        throw new Error('Workflow portability evidence missing');
      await verifyWorkflowPortabilityBrowserEvidence(
        api.database(),
        portabilityFixture.scope,
        portabilityEvidence,
      );
      process.stdout.write(
        `Live browser workflow portability evidence ${JSON.stringify(portabilityEvidence)}\n`,
      );
      return;
    }
    if (scenario === 'input-cases') {
      if (inputCasesEvidence === undefined)
        throw new Error('Workflow input cases evidence missing');
      await verifyWorkflowInputCasesEvidence(
        api.database(),
        inputCasesEvidence,
      );
      process.stdout.write(
        `Live browser workflow input cases verified identities ${JSON.stringify(inputCasesEvidence)}\n`,
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
    if (scenario === 'transforms') {
      if (collectionEvidence === undefined || dateEvidence === undefined)
        throw new Error('Transform browser evidence missing');
      await verifyTransformEvidence(
        api.database(),
        collectionEvidence,
        dateEvidence,
      );
      return;
    }
    if (scenario === 'failure-routing') {
      if (failureRoutingEvidence === undefined || httpEffects === undefined)
        throw new Error('Failure routing browser evidence missing');
      await verifyFailureRoutingEvidence(
        api.database(),
        failureRoutingEvidence,
        httpEffects,
      );
      return;
    }
    if (scenario === 'artifact-inputs') {
      if (httpEffects === undefined)
        throw new Error('Owned artifact HTTP effects missing');
      if (process.env.F45_RELEASE_QUALIFICATION === 'true') {
        expect(httpEffects.requests).toBe(0);
        expect(httpEffects.effects).toBe(0);
        return;
      }
      expect(httpEffects.requests).toBe(7);
      expect(httpEffects.effects).toBe(7);
      const binary = Buffer.alloc(1048576);
      for (let index = 0; index < binary.length; index++)
        binary[index] = index % 256;
      const hash = (value: Buffer | string) =>
        createHash('sha256').update(value).digest('hex');
      expect(httpEffects.bodyHashes.slice(0, 5)).toEqual([
        hash(binary),
        hash('{}'),
        hash(''),
        hash('{}'),
        hash('multipart response source'),
      ]);
      expect(httpEffects.bodyHashes[6]).toBe(hash('one earlier effect'));
      process.stdout.write(
        `Live artifact input destination hashes ${JSON.stringify(httpEffects.bodyHashes)}\n`,
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
