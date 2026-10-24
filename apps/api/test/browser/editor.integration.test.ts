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
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
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
const fixtureState: EditorBrowserFixtureState = {
  browserWasOpened: false,
  collectionEvidence: undefined,
  dateEvidence: undefined,
  apiTokensEvidence: undefined,
  failureRoutingEvidence: undefined,
  httpControl: undefined,
  httpEffects: undefined,
  curatedEffects: undefined,
  curatedFixture: undefined,
  curatedEvidence: undefined,
  evidence: undefined,
  duplicationEvidence: undefined,
  portabilityFixture: undefined,
  portabilityEvidence: undefined,
  inputCasesEvidence: undefined,
  callsEvidence: undefined,
  callableEvidence: undefined,
  receiptEvidence: undefined,
  runRecoveryEvidence: undefined,
  expressionEvidence: undefined,
  readonlyFixture: undefined,
  readonlyEvidence: undefined,
  readonlySetupPending: false,
  scheduleEvidence: undefined,
  scheduleRestart: undefined,
  scheduleRestartUsed: false,
};

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
        fixtureState.browserWasOpened && openBrowserInstances.size === 0,
    }),
  );
  return owner.acquire(name, child, closeChild);
}

const noticeMailKey =
  scenario === 'notifications' ? randomBytes(32).toString('base64') : undefined;
const noticeMessages: string[] = [];

const controlledHttpScenario =
  scenario === 'webhook-controlled-http' ||
  scenario === 'failure-routing' ||
  scenario === 'artifact-inputs' ||
  scenario === 'http-pagination';

const httpMaster =
  controlledHttpScenario ||
  scenario === 'curated-templates' ||
  scenario === 'webhook-responses'
    ? randomBytes(32)
    : undefined;
const httpAuthorization = editorHttpAuthorization();

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
  const fixture = createEditorBrowserFixture();
  registerEditorBrowserJourney(fixture);
});

function editorJourneyPath(selected: typeof scenario): string {
  if (selected === 'artifact-inputs')
    return process.env.F45_RELEASE_QUALIFICATION === 'true'
      ? 'editor/files/maximum-upload.spec.ts'
      : 'editor/files/';
  return EDITOR_JOURNEY_PATHS[selected];
}
const EDITOR_JOURNEY_PATHS = {
  'run-values': 'editor/run-values/journey.spec.ts',
  'http-pagination': 'editor/http-pagination.spec.ts',
  'two-factor': 'authentication/two-factor.spec.ts',
  federation: 'editor/federation/sign-in.spec.ts',
  'organization-oidc': 'editor/federation/organization.spec.ts',
  collaboration: 'editor/collaboration',
  promotion: 'editor/promotions',
  governance: 'editor/governance',
  code: 'editor/code.spec.ts',
  'webhook-responses': 'editor/webhook-responses.spec.ts',
  'pinned-samples': 'editor/pinned-samples.spec.ts',
  notifications: 'editor/notifications/attention.spec.ts',
  variables: 'editor/variables/snapshots.spec.ts',
  forms: 'editor/forms/submission.spec.ts',
  approvals: 'editor/approvals.spec.ts',
  'error-workflows': 'editor/error-workflows.spec.ts',
  'api-tokens': 'api-tokens.spec.ts',
  callable: 'editor/callable.spec.ts',
  'curated-templates': 'curated-templates.spec.ts',
  portability: 'workflow-portability.spec.ts',
  'input-cases': 'workflow-input-cases.spec.ts',
  duplication: 'workflow-duplication.spec.ts',
  'nested-conflict': 'editor/execution.spec.ts',
  receipts: 'editor/receipts.spec.ts',
  'run-recovery': 'editor/run-recovery.spec.ts',
  'expression-admission': 'editor/expression-admission.spec.ts',
  readonly: 'editor/readonly.spec.ts',
  schedule: 'editor/schedule.spec.ts',
  'failure-routing': 'editor/failure-routing.spec.ts',
  transforms: 'editor/transforms.spec.ts',
  'webhook-controlled-http': 'editor/webhook-controlled-http.spec.ts',
} satisfies Record<Exclude<typeof scenario, 'artifact-inputs'>, string>;

interface EditorBrowserFixtureState {
  browserWasOpened: boolean;
  collectionEvidence: z.infer<typeof collectionEvidenceSchema> | undefined;
  dateEvidence: z.infer<typeof dateEvidenceSchema> | undefined;
  apiTokensEvidence: z.infer<typeof apiTokensEvidenceSchema> | undefined;
  failureRoutingEvidence:
    z.infer<typeof failureRoutingEvidenceSchema> | undefined;
  httpControl: ReturnType<typeof createEditorHttpControl> | undefined;
  httpEffects: z.infer<typeof httpEffectsSchema> | undefined;
  curatedEffects: z.infer<typeof curatedTemplateEffectsSchema> | undefined;
  curatedFixture:
    | Awaited<ReturnType<typeof prepareCuratedTemplateBrowserFixture>>
    | undefined;
  curatedEvidence:
    z.infer<typeof curatedTemplateBrowserEvidenceSchema> | undefined;
  evidence: z.infer<typeof browserEvidenceSchema> | undefined;
  duplicationEvidence:
    z.infer<typeof workflowDuplicationEvidenceSchema> | undefined;
  portabilityFixture:
    | Awaited<ReturnType<typeof prepareWorkflowPortabilityBrowserFixture>>
    | undefined;
  portabilityEvidence:
    z.infer<typeof workflowPortabilityBrowserEvidenceSchema> | undefined;
  inputCasesEvidence:
    z.infer<typeof workflowInputCasesEvidenceSchema> | undefined;
  callsEvidence: z.infer<typeof callsEvidenceSchema> | undefined;
  callableEvidence: z.infer<typeof callableEvidenceSchema> | undefined;
  receiptEvidence: z.infer<typeof receiptRecoveryEvidenceSchema> | undefined;
  runRecoveryEvidence: z.infer<typeof runRecoveryEvidenceSchema> | undefined;
  expressionEvidence:
    z.infer<typeof expressionAdmissionEvidenceSchema> | undefined;
  readonlyFixture:
    Awaited<ReturnType<typeof prepareReadonlyEvidence>> | undefined;
  readonlyEvidence: z.infer<typeof readonlyEvidenceSchema> | undefined;
  readonlySetupPending: boolean;
  scheduleEvidence: z.infer<typeof scheduleEvidenceSchema> | undefined;
  scheduleRestart:
    | {
        scope: z.infer<typeof scheduleScopeSchema>;
        triggerId: string;
        nextFireAt: string;
        requestId: string;
      }
    | undefined;
  scheduleRestartUsed: boolean;
}

function editorHttpAuthorization() {
  if (!controlledHttpScenario) return undefined;
  if (scenario === 'artifact-inputs')
    return 'Bearer owned-artifact-destination';
  return `Bearer ${randomUUID()}`;
}

function createEditorBrowserFixture() {
  let worker: ChildProcess;

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
      fixtureState.httpControl = owner.acquire(
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
        fixtureState.curatedEffects = curatedObservation.data;
        return;
      }
      const observation = httpEffectsSchema.safeParse(value);
      if (observation.success) {
        fixtureState.httpEffects = observation.data;
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

  const api = useEditorApiFixture({
    redis,
    get worker() {
      return worker;
    },
    get oidcProvider() {
      return oidcProvider;
    },
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
  return {
    api,
    identityProvider,
    get oidcProvider() {
      return oidcProvider;
    },
    get worker() {
      return worker;
    },
  };
}
function registerEditorBrowserJourney(
  fixture: ReturnType<typeof createEditorBrowserFixture>,
): void {
  const { api, identityProvider } = fixture;
  it(`executes the owned real-browser scenario: ${scenario}`, async () => {
    const apiOrigin = await prepareEditorPrerequisites(api);
    const context = { fixture, api, apiOrigin, identityProvider };
    const mailServer = createEditorControlServer(context);
    await runEditorBrowserJourney(context, mailServer);
    await verifyEditorBrowserOutcome(context);
  }, 180_000);
}

type EditorBrowserApi = ReturnType<typeof useBetterAuthRealApi>;
function useEditorApiFixture(context: {
  readonly redis: URL;
  readonly worker: ChildProcess;
  readonly oidcProvider:
    Awaited<ReturnType<typeof createBrowserOidcProvider>> | undefined;
}): EditorBrowserApi {
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
    redisUrl: context.redis.toString(),
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
      const ready = phase(context.worker, 'worker-ready');
      context.worker.send({
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
  return api;
}
interface EditorBrowserJourneyContext {
  readonly fixture: ReturnType<typeof createEditorBrowserFixture>;
  readonly api: EditorBrowserApi;
  readonly apiOrigin: string;
  readonly identityProvider: ReturnType<typeof createBrowserIdentityProvider>;
}
async function prepareEditorPrerequisites(api: EditorBrowserApi) {
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

  const createdWorkflow = await api.send('POST', `${workspacePath}/workflows`, {
    browser,
    headers: { 'Idempotency-Key': randomUUID() },
    payload: { name: 'Prerequisite' },
  });

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
    fixtureState.portabilityFixture =
      await prepareWorkflowPortabilityBrowserFixture(api, webOrigin);

  if (scenario === 'curated-templates')
    fixtureState.curatedFixture = await prepareCuratedTemplateBrowserFixture(
      api,
      webOrigin,
      recheckOwnership,
    );

  fixtureState.httpControl?.setApiOrigin(apiOrigin);

  const readiness = await fetch(`${apiOrigin}/health/ready`);

  expect(readiness.status).toBe(200);
  return apiOrigin;
}
function createEditorControlServer(context: EditorBrowserJourneyContext) {
  const { identityProvider } = context;

  // Separate loopback test-control listener for the local mail sink and
  // non-secret result IDs. This is never registered in the application API.
  const mailServer = createServer((request, response) => {
    if (scenario === 'federation' && identityProvider.handle(request, response))
      return;
    if (fixtureState.httpControl?.handle(request, response) === true) return;
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (handleEditorCallbackResume({ context, request, response, url })) return;

    if (handleEditorOidcMetadata({ context, request, response, url })) return;
    if (handleEditorCuratedSeed({ context, request, response, url })) return;
    if (handleEditorPortabilitySeed({ context, request, response, url }))
      return;
    if (handleEditorPortabilityDenial({ context, request, response, url }))
      return;
    if (handleEditorBrowserReceipt({ context, request, response, url })) return;
    if (handleEditorVerificationLink({ context, request, response, url }))
      return;
    if (handleEditorReadonlySetup({ context, request, response, url })) return;
    if (handleEditorScheduleRestart({ context, request, response, url }))
      return;
    if (handleEditorEvidenceReceipt({ context, request, response, url }))
      return;
    if (handleEditorNoticeMail({ context, request, response, url })) return;
    response.writeHead(404).end();
  });
  return mailServer;
}
async function runEditorBrowserJourney(
  context: EditorBrowserJourneyContext,
  mailServer: ReturnType<typeof createServer>,
) {
  const { apiOrigin, identityProvider } = context;

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
          editorJourneyPath(scenario),
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
}
function verifyEditorBrowserOutcome(context: EditorBrowserJourneyContext) {
  return editorOutcomeChecks[scenario](context);
}

async function verifyEditorOrganizationOidcOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
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
async function verifyEditorRunValuesOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  const rows = await api
    .database()
    .query<{ key: string; value: string }>(
      'select key,value from app.workflow_run_values order by key',
    );
  expect(rows.rows).toEqual([{ key: 'orderId', value: 'A-1042' }]);
  return;
}
function verifyEditorTwoFactorOutcome(_context: EditorBrowserJourneyContext) {
  return;
}
async function verifyEditorFederationOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
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
async function verifyEditorCodeOutcome(context: EditorBrowserJourneyContext) {
  const { api } = context;
  await verifyCodeEvidence(api.database());
  return;
}
async function verifyEditorWebhookResponsesOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  await verifyWebhookResponseEvidence(api.database());
  return;
}
async function verifyEditorPinnedSamplesOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  await verifySampleEvidence(api.database());
  return;
}
async function verifyEditorNotificationsOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  await verifyNotificationEvidence(api.database(), noticeMessages);
  return;
}
async function verifyEditorCollaborationOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  const rows = await api
    .database()
    .query<{ comments: number; mentions: number }>(
      'select (select count(*)::int from app.workflow_comments) comments,(select count(*)::int from app.workflow_comment_mentions) mentions',
    );
  expect(rows.rows[0]?.comments).toBeGreaterThanOrEqual(2);
  expect(rows.rows[0]?.mentions).toBeGreaterThanOrEqual(1);
  return;
}
async function verifyEditorPromotionOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  const rows = await api
    .database()
    .query<{ origins: number; versions: number }>(
      `select (select count(*)::int from app.workflow_promotion_origins) origins,(select count(*)::int from app.workflow_version_promotions) versions`,
    );
  expect(rows.rows[0]).toEqual({ origins: 2, versions: 2 });
  return;
}
async function verifyEditorGovernanceOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  const rows = await api
    .database()
    .query<{ count: number }>(
      "select count(*)::int count from app.audit_events where action='workspace.governance_changed' and metadata->>'auditRetentionDays'='30'",
    );
  expect(rows.rows[0]?.count).toBe(2);
  return;
}
async function verifyEditorVariablesOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  await verifyVariableEvidence(api.database());
  return;
}
async function verifyEditorFormsOutcome(context: EditorBrowserJourneyContext) {
  const { api } = context;
  await verifyFormEvidence(api.database());
  return;
}
async function verifyEditorApprovalsOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  await verifyApprovalEvidence(api.database());
  await verifyCallbackEvidence(api.database());
  return;
}
async function verifyEditorErrorWorkflowsOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  await verifyErrorWorkflowEvidence(api.database());
  return;
}
async function verifyEditorApiTokensOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (fixtureState.apiTokensEvidence === undefined)
    throw new Error('API token browser evidence missing');
  await verifyApiTokensEvidence(api.database(), fixtureState.apiTokensEvidence);
  return;
}
async function verifyEditorCallableOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (fixtureState.callableEvidence === undefined)
    throw new Error('Callable browser evidence missing');
  await verifyCallableEvidence(api.database(), fixtureState.callableEvidence);
  if (fixtureState.callsEvidence === undefined)
    throw new Error('Workflow Call browser evidence missing');
  await verifyCallsEvidence(api.database(), fixtureState.callsEvidence);
  process.stdout.write(
    `Live browser callable verified identities ${JSON.stringify(fixtureState.callableEvidence)}\n`,
  );
  return;
}
async function verifyEditorCuratedTemplatesOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { apiOrigin, fixture } = context;
  if (
    fixtureState.curatedFixture === undefined ||
    fixtureState.curatedEvidence === undefined
  )
    throw new Error('Curated template browser evidence missing');
  await fixtureState.curatedFixture.verifyEvidence(
    fixtureState.curatedEvidence,
  );
  await recheckOwnership();
  const runs = await fixtureState.curatedFixture.executeGraphs(
    fixtureState.curatedEvidence,
  );
  await recheckOwnership();
  const triggerRuns = await fixtureState.curatedFixture.executeTriggers(
    fixtureState.curatedEvidence,
    apiOrigin,
  );
  await closeChild(fixture.worker);
  if (fixtureState.curatedEffects === undefined)
    throw new Error('Controlled curated worker effects missing');
  expect(
    fixtureState.curatedEffects.observations.map(({ kind, status }) => ({
      kind,
      status,
    })),
  ).toEqual([
    { kind: 'http', status: 200 },
    { kind: 'slack', status: 200 },
    { kind: 'http', status: 204 },
    { kind: 'http', status: 500 },
  ]);
  expect(fixtureState.curatedEffects.pendingHttpResponses).toBe(0);
  process.stdout.write(
    `Live browser curated template verified identities ${JSON.stringify({ ...fixtureState.curatedEvidence, runs, triggerRuns, effects: fixtureState.curatedEffects })}\n`,
  );
  return;
}
async function verifyEditorPortabilityOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (
    fixtureState.portabilityFixture === undefined ||
    fixtureState.portabilityEvidence === undefined
  )
    throw new Error('Workflow portability evidence missing');
  await verifyWorkflowPortabilityBrowserEvidence(
    api.database(),
    fixtureState.portabilityFixture.scope,
    fixtureState.portabilityEvidence,
  );
  process.stdout.write(
    `Live browser workflow portability evidence ${JSON.stringify(fixtureState.portabilityEvidence)}\n`,
  );
  return;
}
async function verifyEditorInputCasesOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (fixtureState.inputCasesEvidence === undefined)
    throw new Error('Workflow input cases evidence missing');
  await verifyWorkflowInputCasesEvidence(
    api.database(),
    fixtureState.inputCasesEvidence,
  );
  process.stdout.write(
    `Live browser workflow input cases verified identities ${JSON.stringify(fixtureState.inputCasesEvidence)}\n`,
  );
  return;
}
async function verifyEditorDuplicationOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (fixtureState.duplicationEvidence === undefined)
    throw new Error('Workflow duplication evidence missing');
  await verifyWorkflowDuplicationEvidence(
    api.database(),
    fixtureState.duplicationEvidence,
  );
  process.stdout.write(
    `Live browser workflow duplication evidence ${JSON.stringify(fixtureState.duplicationEvidence)}\n`,
  );
  return;
}
async function verifyEditorTransformsOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (
    fixtureState.collectionEvidence === undefined ||
    fixtureState.dateEvidence === undefined
  )
    throw new Error('Transform browser evidence missing');
  await verifyTransformEvidence(
    api.database(),
    fixtureState.collectionEvidence,
    fixtureState.dateEvidence,
  );
  return;
}
async function verifyEditorFailureRoutingOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (
    fixtureState.failureRoutingEvidence === undefined ||
    fixtureState.httpEffects === undefined
  )
    throw new Error('Failure routing browser evidence missing');
  await verifyFailureRoutingEvidence(
    api.database(),
    fixtureState.failureRoutingEvidence,
    fixtureState.httpEffects,
  );
  return;
}
function verifyEditorArtifactInputsOutcome(
  _context: EditorBrowserJourneyContext,
) {
  if (fixtureState.httpEffects === undefined)
    throw new Error('Owned artifact HTTP effects missing');
  if (process.env.F45_RELEASE_QUALIFICATION === 'true') {
    expect(fixtureState.httpEffects.requests).toBe(0);
    expect(fixtureState.httpEffects.effects).toBe(0);
    return;
  }
  expect(fixtureState.httpEffects.requests).toBe(7);
  expect(fixtureState.httpEffects.effects).toBe(7);
  const binary = Buffer.alloc(1048576);
  for (let index = 0; index < binary.length; index++)
    binary[index] = index % 256;
  const hash = (value: Buffer | string) =>
    createHash('sha256').update(value).digest('hex');
  expect(fixtureState.httpEffects.bodyHashes.slice(0, 5)).toEqual([
    hash(binary),
    hash('{}'),
    hash(''),
    hash('{}'),
    hash('multipart response source'),
  ]);
  expect(fixtureState.httpEffects.bodyHashes[6]).toBe(
    hash('one earlier effect'),
  );
  process.stdout.write(
    `Live artifact input destination hashes ${JSON.stringify(fixtureState.httpEffects.bodyHashes)}\n`,
  );
  return;
}
async function verifyEditorWebhookControlledHttpOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (
    fixtureState.httpControl === undefined ||
    fixtureState.httpEffects === undefined
  )
    throw new Error('Owned HTTP control/effect evidence missing');
  const submitted = fixtureState.httpControl.readEvidence();
  process.stdout.write(
    `Live browser controlled HTTP submitted/unverified identities ${JSON.stringify(submittedHttpEvidenceIds(submitted))}\n`,
  );
  await verifyHttpEvidence(api.database(), submitted, fixtureState.httpEffects);
  process.stdout.write(
    `Live browser controlled HTTP verified evidence ${JSON.stringify({ ...submitted, effects: fixtureState.httpEffects })}\n`,
  );
  return;
}
async function verifyEditorScheduleOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (
    fixtureState.scheduleEvidence === undefined ||
    fixtureState.scheduleRestart === undefined
  )
    throw new Error('Schedule restart/evidence missing');
  expect(fixtureState.scheduleRestart.scope).toEqual({
    workspaceId: fixtureState.scheduleEvidence.workspaceId,
    workflowId: fixtureState.scheduleEvidence.workflowId,
    workflowVersionId: fixtureState.scheduleEvidence.workflowVersionId,
  });
  expect(fixtureState.scheduleEvidence.triggerId).toBe(
    fixtureState.scheduleRestart.triggerId,
  );
  expect(fixtureState.scheduleEvidence.firstDueAt).toBe(
    fixtureState.scheduleRestart.nextFireAt,
  );
  process.stdout.write(
    `Live browser schedule submitted/unverified ${JSON.stringify({
      workspaceId: fixtureState.scheduleEvidence.workspaceId,
      workflowId: fixtureState.scheduleEvidence.workflowId,
      workflowVersionId: fixtureState.scheduleEvidence.workflowVersionId,
      triggerId: fixtureState.scheduleEvidence.triggerId,
      runId: fixtureState.scheduleEvidence.runId,
      occurrenceId: fixtureState.scheduleEvidence.occurrenceId,
      restartRequestId: fixtureState.scheduleRestart.requestId,
      firstDueAt: fixtureState.scheduleEvidence.firstDueAt,
      scheduledAt: fixtureState.scheduleEvidence.scheduledAt,
    })}\n`,
  );
  await verifyScheduleEvidence(api.database(), fixtureState.scheduleEvidence);
  process.stdout.write(
    `Live browser schedule evidence ${JSON.stringify({ ...fixtureState.scheduleEvidence, restartRequestId: fixtureState.scheduleRestart.requestId })}\n`,
  );
  return;
}
async function verifyEditorReadonlyOutcome(
  _context: EditorBrowserJourneyContext,
) {
  if (
    fixtureState.readonlyFixture === undefined ||
    fixtureState.readonlyEvidence === undefined
  )
    throw new Error('Readonly editor evidence missing');
  await fixtureState.readonlyFixture.verify(fixtureState.readonlyEvidence);
  process.stdout.write(
    `Live browser readonly evidence ${JSON.stringify(fixtureState.readonlyEvidence)}\n`,
  );
  return;
}
async function verifyEditorExpressionAdmissionOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (fixtureState.expressionEvidence === undefined)
    throw new Error('Expression admission evidence missing');
  await verifyExpressionAdmissionEvidence(
    api.database(),
    fixtureState.expressionEvidence,
  );
  process.stdout.write(
    `Live browser expression admission ${JSON.stringify(fixtureState.expressionEvidence)}\n`,
  );
  return;
}
async function verifyEditorReceiptsOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (fixtureState.receiptEvidence === undefined)
    throw new Error('Receipt recovery evidence missing');
  await verifyReceiptRecoveryEvidence(
    api.database(),
    fixtureState.receiptEvidence,
  );
  process.stdout.write(
    `Live browser receipt recovery ${JSON.stringify(fixtureState.receiptEvidence)}\n`,
  );
  return;
}
async function verifyEditorRunRecoveryOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  if (fixtureState.runRecoveryEvidence === undefined)
    throw new Error('Run recovery evidence missing');
  await verifyRunRecoveryEvidence(
    api.database(),
    fixtureState.runRecoveryEvidence,
  );
  process.stdout.write(
    `Live browser run recovery ${JSON.stringify(fixtureState.runRecoveryEvidence)}\n`,
  );
  return;
}
async function verifyEditorNestedOutcome(context: EditorBrowserJourneyContext) {
  const { api } = context;
  expect(fixtureState.evidence).toBeDefined();
  const persisted = await api.database().query<{
    status: string;
    workflow_id: string;
    workspace_id: string;
    workflow_version_id: string;
  }>('select status, workflow_id, workspace_id, workflow_version_id from app.workflow_runs where id=$1', [fixtureState.evidence?.runId]);
  expect(persisted.rows).toEqual([
    {
      status: 'succeeded',
      workflow_id: fixtureState.evidence?.workflowId,
      workspace_id: fixtureState.evidence?.workspaceId,
      workflow_version_id: fixtureState.evidence?.workflowVersionId,
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
    [fixtureState.evidence?.runId, fixtureState.evidence?.workspaceId],
  );
  expect(nodes.rows).toHaveLength(8);
  expect(nodes.rows.every((node) => node.status === 'succeeded')).toBe(true);
  const leaves = nodes.rows.filter(
    (node) => node.node_id === fixtureState.evidence?.leafId,
  );
  expect(leaves).toHaveLength(4);
  expect(new Set(leaves.map((node) => node.invocation_key)).size).toBe(4);
  expect(leaves.map((node) => node.branch_context)).toEqual(
    expect.arrayContaining(
      [0, 1].flatMap((outer) =>
        [0, 1].map((inner) => ({
          branchPath: [],
          iterationPath: [
            { loopNodeId: fixtureState.evidence?.outerId, ordinal: outer },
            { loopNodeId: fixtureState.evidence?.innerId, ordinal: inner },
          ],
        })),
      ),
    ),
  );
  expect(
    nodes.rows.filter(
      (node) => node.node_id === fixtureState.evidence?.innerId,
    ),
  ).toHaveLength(2);
  await verifyEditorDraftConflictOutcome(api);
}

interface EditorControlRequest {
  readonly context: EditorBrowserJourneyContext;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
}
const editorEvidenceReceipts = new Map<
  string,
  {
    readonly scenario: typeof scenario;
    readonly accept: (value: unknown) => void;
  }
>([
  [
    '/evidence/api-tokens',
    {
      scenario: 'api-tokens',
      accept: (value: unknown) => {
        fixtureState.apiTokensEvidence = apiTokensEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/transforms',
    {
      scenario: 'transforms',
      accept: (value: unknown) => {
        fixtureState.collectionEvidence = collectionEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/transform-date',
    {
      scenario: 'transforms',
      accept: (value: unknown) => {
        fixtureState.dateEvidence = dateEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/callable',
    {
      scenario: 'callable',
      accept: (value: unknown) => {
        fixtureState.callableEvidence = callableEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/calls',
    {
      scenario: 'callable',
      accept: (value: unknown) => {
        fixtureState.callsEvidence = callsEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/curated-templates',
    {
      scenario: 'curated-templates',
      accept: (value: unknown) => {
        fixtureState.curatedEvidence =
          curatedTemplateBrowserEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/portability',
    {
      scenario: 'portability',
      accept: (value: unknown) => {
        fixtureState.portabilityEvidence =
          workflowPortabilityBrowserEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence',
    {
      scenario: 'nested-conflict',
      accept: (value: unknown) => {
        fixtureState.evidence = browserEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/receipts',
    {
      scenario: 'receipts',
      accept: (value: unknown) => {
        fixtureState.receiptEvidence =
          receiptRecoveryEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/failure-routing',
    {
      scenario: 'failure-routing',
      accept: (value: unknown) => {
        fixtureState.failureRoutingEvidence =
          failureRoutingEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/run-recovery',
    {
      scenario: 'run-recovery',
      accept: (value: unknown) => {
        fixtureState.runRecoveryEvidence =
          runRecoveryEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/expression-admission',
    {
      scenario: 'expression-admission',
      accept: (value: unknown) => {
        fixtureState.expressionEvidence =
          expressionAdmissionEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/duplication',
    {
      scenario: 'duplication',
      accept: (value: unknown) => {
        fixtureState.duplicationEvidence =
          workflowDuplicationEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/input-cases-evidence',
    {
      scenario: 'input-cases',
      accept: (value: unknown) => {
        fixtureState.inputCasesEvidence =
          workflowInputCasesEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/readonly',
    {
      scenario: 'readonly',
      accept: (value: unknown) => {
        fixtureState.readonlyEvidence = readonlyEvidenceSchema.parse(value);
      },
    },
  ],
  [
    '/evidence/schedule',
    {
      scenario: 'schedule',
      accept: (value: unknown) => {
        fixtureState.scheduleEvidence = scheduleEvidenceSchema.parse(value);
      },
    },
  ],
]);
function handleEditorCallbackResume(input: EditorControlRequest): boolean {
  const { request, response, url, context } = input;
  const { api, apiOrigin } = context;
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
      if (task === undefined) throw new Error('No owned pending test callback');
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
    return true;
  }
  return false;
}
function handleEditorOidcMetadata(input: EditorControlRequest): boolean {
  const { request, response, url, context } = input;
  const { fixture } = context;
  if (
    scenario === 'organization-oidc' &&
    request.method === 'GET' &&
    url.pathname === '/organization-provider' &&
    fixture.oidcProvider !== undefined
  ) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ issuer: fixture.oidcProvider.origin }));
    return true;
  }
  return false;
}
function handleEditorCuratedSeed(input: EditorControlRequest): boolean {
  const { request, response, url } = input;
  if (
    request.method === 'GET' &&
    url.pathname === '/curated-template-seed' &&
    scenario === 'curated-templates' &&
    fixtureState.curatedFixture !== undefined
  ) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(fixtureState.curatedFixture.scope));
    return true;
  }
  return false;
}
function handleEditorPortabilitySeed(input: EditorControlRequest): boolean {
  const { request, response, url } = input;
  if (
    request.method === 'GET' &&
    url.pathname === '/workflow-portability-seed' &&
    scenario === 'portability' &&
    fixtureState.portabilityFixture !== undefined
  ) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(fixtureState.portabilityFixture.scope));
    return true;
  }
  return false;
}
function handleEditorPortabilityDenial(input: EditorControlRequest): boolean {
  const { request, response, url } = input;
  if (
    request.method === 'POST' &&
    url.pathname === '/workflow-portability-deny' &&
    scenario === 'portability' &&
    fixtureState.portabilityFixture !== undefined
  ) {
    void fixtureState.portabilityFixture.deny().then(
      () => response.writeHead(204).end(),
      () => response.writeHead(400).end(),
    );
    return true;
  }
  return false;
}
function handleEditorBrowserReceipt(input: EditorControlRequest): boolean {
  const { request, response, url } = input;
  if (
    request.method === 'POST' &&
    (url.pathname === '/browser-opened' || url.pathname === '/browser-disposed')
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
          fixtureState.browserWasOpened = true;
          openBrowserInstances.add(value.instanceId);
        } else if (!openBrowserInstances.delete(value.instanceId))
          throw new Error('Unknown browser receipt');
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
    });
    return true;
  }
  return false;
}
function handleEditorVerificationLink(input: EditorControlRequest): boolean {
  const { request, response, url, context } = input;
  const { api } = context;
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
    return true;
  }
  return false;
}
function handleEditorReadonlySetup(input: EditorControlRequest): boolean {
  const { request, response, url, context } = input;
  const { api } = context;
  if (request.method === 'POST' && url.pathname === '/readonly-setup') {
    if (
      !['readonly', 'approvals', 'governance', 'collaboration'].includes(
        scenario,
      ) ||
      fixtureState.readonlyFixture !== undefined ||
      fixtureState.readonlySetupPending
    ) {
      response.writeHead(409).end();
      return true;
    }
    fixtureState.readonlySetupPending = true;
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_024) request.destroy();
    });
    request.on('end', () => {
      void (async () => {
        try {
          fixtureState.readonlyFixture = await prepareReadonlyEvidence(
            api.database(),
            readonlySetupSchema.parse(JSON.parse(body)),
          );
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(fixtureState.readonlyFixture.scope));
        } catch {
          response.writeHead(400).end();
        } finally {
          fixtureState.readonlySetupPending = false;
        }
      })();
    });
    return true;
  }
  return false;
}
function handleEditorScheduleRestart(input: EditorControlRequest): boolean {
  const { request, response, url, context } = input;
  const { api, fixture } = context;
  if (request.method === 'POST' && url.pathname === '/schedule-restart') {
    if (
      scenario !== 'schedule' ||
      fixtureState.scheduleRestartUsed ||
      restartScope.signal.aborted
    ) {
      response.writeHead(409).end();
      return true;
    }
    fixtureState.scheduleRestartUsed = true;
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_024) request.destroy();
    });
    request.on('end', () => {
      void (async () => {
        try {
          const scope = scheduleScopeSchema.parse(JSON.parse(body));
          const before = await observeScheduleBeforeDue(api.database(), scope);
          const requestId = randomUUID();
          await restartEditorBrowserWorker(
            fixture.worker,
            requestId,
            restartScope.signal,
          );
          assertRestartScopeActive();
          const after = await observeScheduleBeforeDue(api.database(), scope);
          assertRestartScopeActive();
          expect({ ...after, observedAt: before.observedAt }).toEqual(before);
          fixtureState.scheduleRestart = {
            scope,
            triggerId: before.triggerId,
            nextFireAt: before.nextFireAt,
            requestId,
          };
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              ...fixtureState.scheduleRestart,
              beforeObservedAt: before.observedAt,
              afterObservedAt: after.observedAt,
            }),
          );
        } catch {
          response.writeHead(400).end();
        }
      })();
    });
    return true;
  }
  return false;
}
function handleEditorEvidenceReceipt(input: EditorControlRequest): boolean {
  const { request, response, url } = input;
  const receipt = editorEvidenceReceipts.get(url.pathname);
  if (request.method === 'POST' && receipt !== undefined) {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_024) request.destroy();
    });
    request.on('end', () => {
      try {
        const value: unknown = JSON.parse(body);
        if (receipt.scenario !== scenario)
          throw new Error('Evidence does not match the selected scenario');
        receipt.accept(value);
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end();
      }
    });
    return true;
  }
  return false;
}
function handleEditorNoticeMail(input: EditorControlRequest): boolean {
  const { request, response, url } = input;
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
    return true;
  }
  return false;
}

const editorOutcomeChecks: Record<
  typeof scenario,
  (context: EditorBrowserJourneyContext) => void | Promise<void>
> = {
  'organization-oidc': verifyEditorOrganizationOidcOutcome,
  'run-values': verifyEditorRunValuesOutcome,
  'two-factor': verifyEditorTwoFactorOutcome,
  'http-pagination': verifyEditorTwoFactorOutcome,
  federation: verifyEditorFederationOutcome,
  code: verifyEditorCodeOutcome,
  'webhook-responses': verifyEditorWebhookResponsesOutcome,
  'pinned-samples': verifyEditorPinnedSamplesOutcome,
  notifications: verifyEditorNotificationsOutcome,
  collaboration: verifyEditorCollaborationOutcome,
  promotion: verifyEditorPromotionOutcome,
  governance: verifyEditorGovernanceOutcome,
  variables: verifyEditorVariablesOutcome,
  forms: verifyEditorFormsOutcome,
  approvals: verifyEditorApprovalsOutcome,
  'error-workflows': verifyEditorErrorWorkflowsOutcome,
  'api-tokens': verifyEditorApiTokensOutcome,
  callable: verifyEditorCallableOutcome,
  'curated-templates': verifyEditorCuratedTemplatesOutcome,
  portability: verifyEditorPortabilityOutcome,
  'input-cases': verifyEditorInputCasesOutcome,
  duplication: verifyEditorDuplicationOutcome,
  transforms: verifyEditorTransformsOutcome,
  'failure-routing': verifyEditorFailureRoutingOutcome,
  'artifact-inputs': verifyEditorArtifactInputsOutcome,
  'webhook-controlled-http': verifyEditorWebhookControlledHttpOutcome,
  schedule: verifyEditorScheduleOutcome,
  readonly: verifyEditorReadonlyOutcome,
  'expression-admission': verifyEditorExpressionAdmissionOutcome,
  receipts: verifyEditorReceiptsOutcome,
  'run-recovery': verifyEditorRunRecoveryOutcome,
  'nested-conflict': verifyEditorNestedOutcome,
};
async function verifyEditorDraftConflictOutcome(api: EditorBrowserApi) {
  const draft = await api
    .database()
    .query<{ revision: number; graph_json: unknown }>(
      'select revision,graph_json from app.workflow_drafts where workflow_id=$1 and workspace_id=$2',
      [fixtureState.evidence?.workflowId, fixtureState.evidence?.workspaceId],
    );
  expect(draft.rows).toHaveLength(1);
  expect(draft.rows[0]?.revision).toBe(
    fixtureState.evidence?.finalDraftRevision,
  );
  expect(fixtureState.evidence?.finalDraftRevision).toBeGreaterThan(
    fixtureState.evidence?.conflictRevision ?? 0,
  );
  const draftRoot = workflowGraphSchema
    .parse(draft.rows[0]?.graph_json)
    .nodes.find((node) => node.id === fixtureState.evidence?.rootId);
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
      [fixtureState.evidence?.workflowId, fixtureState.evidence?.workspaceId],
    );
  expect(versions.rows).toHaveLength(1);
  expect(versions.rows[0]?.id).toBe(fixtureState.evidence?.workflowVersionId);
  expect(
    workflowGraphSchema
      .parse(versions.rows[0]?.graph_json)
      .nodes.find((node) => node.id === fixtureState.evidence?.rootId),
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
      [fixtureState.evidence?.workflowId, fixtureState.evidence?.workspaceId],
    );
  expect(counts.rows).toEqual([{ count: 1 }]);
  process.stdout.write(
    `Live browser durable evidence ${JSON.stringify(fixtureState.evidence)}\n`,
  );
}
