import { createHash, randomUUID } from 'node:crypto';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';

import {
  auditEvents,
  createIdentityWorkspaceDatabase,
  createOidcLoginTransactionStore,
  createWorkspaceDatabase,
  parseDatabaseConfig,
  outboxEvents,
  runCheckpoints,
  runEvents,
  workflowRuns,
  workspaceMemberships,
  workspaces,
  type WorkspaceDatabase,
  type IdentityWorkspaceDatabase,
} from '@pertexo/database/testing';
import { createApplicationSecretEnvelope } from '@pertexo/integrations/server';
import { workflowRunListResponseSchema } from '@pertexo/contracts/workflow-runs';
import type {
  StructuredLogger,
  TelemetryLifecycle,
} from '@pertexo/observability';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApiApplication } from '../../src/app.js';
import { createOidcSecretEncryptionAdapter } from '../../src/identity-infrastructure/index.js';
import type {
  OidcAuthorizationRequest,
  OidcProviderPort,
} from '../../src/identity/index.js';
import type { ApiConfig } from '../../src/platform/config/api-config.js';
import { createApiIdentityRuntime } from '../../src/platform/identity/identity-runtime.module.js';
import { createActorContext } from '../../src/workspaces/index.js';
import { StreamRunEventsUseCase } from '../../src/workflow-runs/index.js';
import {
  FixtureResourceOwner,
  rethrowFixtureSetupFailure,
} from '../support/fixture-resource-owner.js';

const apiUrl = process.env.DATABASE_API_URL;
const redisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
const enabled =
  process.env.API_IDENTITY_INTEGRATION === 'true' && apiUrl !== undefined;
const ownerRole = process.env.POSTGRES_OWNER_USER ?? 'pertexo_owner';
const issuer = 'https://identity.integration.test';
const clientId = 'phase1-real-api';
const encryptionKey = Buffer.alloc(32, 0x5a).toString('base64');
const databaseConfig = parseDatabaseConfig({
  connectionString: apiUrl ?? 'postgresql://invalid:invalid@localhost/invalid',
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  max: 4,
  ownerRole,
});

const logger: StructuredLogger = {
  debug: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  info: () => undefined,
  trace: () => undefined,
  warn: () => undefined,
};
const telemetry: TelemetryLifecycle = {
  enabled: false,
  started: false,
  start: () => undefined,
  shutdown: () => Promise.resolve(),
};

class FakeOidcProvider implements OidcProviderPort {
  public latestRequest: OidcAuthorizationRequest | undefined;
  public latestVerifier: string | undefined;
  public exchangeCount = 0;
  public profile = {
    subject: 'phase1-real-stack-user',
    email: 'phase1-real-stack@example.test',
    displayName: 'Phase One Real Stack',
    emailVerified: true,
  };

  public authorizationUrl(request: OidcAuthorizationRequest): string {
    this.latestRequest = request;
    const url = new URL(`${issuer}/authorize`);
    url.searchParams.set('client_id', request.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('scope', request.scopes.join(' '));
    url.searchParams.set('state', request.state);
    url.searchParams.set('nonce', request.nonce);
    url.searchParams.set('code_challenge', request.codeChallenge);
    url.searchParams.set('code_challenge_method', request.codeChallengeMethod);
    return url.toString();
  }

  public exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) {
    this.exchangeCount += 1;
    this.latestVerifier = input.codeVerifier;
    if (input.code === 'provider-failure') {
      throw new Error('provider-secret-must-never-leak');
    }
    const request = this.latestRequest;
    if (request === undefined) throw new Error('authorization was not started');
    return Promise.resolve({
      issuer,
      subject: this.profile.subject,
      audience: clientId,
      nonce:
        input.code === 'bad-nonce'
          ? 'forged-nonce-that-does-not-match'
          : request.nonce,
      email: this.profile.email,
      displayName: this.profile.displayName,
      emailVerified: this.profile.emailVerified,
    });
  }
}

type SessionCookies = Readonly<{
  rawSession: string;
  csrf: string;
  cookieHeader: string;
}>;

describe.runIf(enabled)('Phase 1 real PostgreSQL API identity slice', () => {
  const provider = new FakeOidcProvider();
  let application: Awaited<ReturnType<typeof createApiApplication>>;
  let identityDatabase: IdentityWorkspaceDatabase;
  let workspaceDatabase: WorkspaceDatabase;
  let resources: FixtureResourceOwner | undefined;
  let identityNow = new Date();
  let loginAttempt = 0;

  beforeAll(async () => {
    const owner = new FixtureResourceOwner();
    resources = owner;
    try {
      identityDatabase = owner.acquire(
        'identity database',
        createIdentityWorkspaceDatabase(databaseConfig),
        (database) => database.close(),
      );
      const transactionStore = owner.acquire(
        'OIDC transaction store',
        createOidcLoginTransactionStore(
          databaseConfig,
          createOidcSecretEncryptionAdapter({
            current: { version: 'integration-v1', key: encryptionKey },
          }),
        ),
        (store) => store.close(),
      );
      workspaceDatabase = owner.acquire(
        'workspace database',
        createWorkspaceDatabase(databaseConfig),
        (database) => database.close(),
      );
      const identityConfig = config().identity;
      if (identityConfig === undefined)
        throw new Error('Identity integration configuration is missing');
      owner.transfer(identityDatabase);
      owner.transfer(transactionStore);
      const identityRuntime = owner.acquire(
        'identity runtime',
        await createApiIdentityRuntime(identityConfig, databaseConfig, {
          provider,
          persistence: {
            database: identityDatabase,
            transactions: transactionStore,
          },
          clock: { now: () => new Date(identityNow.getTime()) },
        }),
        (runtime) => runtime.close(),
      );
      const borrowedIdentityRuntime = Object.freeze({
        dependencies: identityRuntime.dependencies,
        close: () => Promise.resolve(),
      });
      application = owner.acquire(
        'API application',
        await createApiApplication(config(), {
          database: workspaceDatabase,
          identityRuntime: borrowedIdentityRuntime,
          logger,
          telemetry,
        }),
        (app) => app.close(),
      );
      await application.init();
    } catch (error: unknown) {
      await rethrowFixtureSetupFailure(owner, error);
    }
  });

  afterAll(async () => {
    await resources?.close();
  });

  it('persists state, nonce, and PKCE and establishes only secure opaque cookies', async () => {
    const start = await startLogin();
    const request = requireAuthorizationRequest();
    const authorizationUrl = new URL(start.authorizationUrl);
    expect(authorizationUrl.searchParams.get('state')).toBe(request.state);
    expect(authorizationUrl.searchParams.get('nonce')).toBe(request.nonce);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe(
      'S256',
    );
    expect(start.browserCookie).toMatch(/^pertexo_oidc_binding=[^;]+$/u);

    const exchangeCountBeforeBindingChecks = provider.exchangeCount;
    const missingBinding = await application.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=valid&state=${encodeURIComponent(request.state)}`,
    });
    expectProblem(missingBinding, 400, 'request.invalid');
    expect(String(missingBinding.headers['set-cookie'])).toContain(
      'pertexo_oidc_binding=; Path=/v1/auth/oidc/callback; Max-Age=0',
    );
    const wrongBinding = await application.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=valid&state=${encodeURIComponent(request.state)}`,
      headers: { cookie: 'pertexo_oidc_binding=wrong-browser' },
    });
    expectProblem(wrongBinding, 400, 'request.invalid');
    expect(provider.exchangeCount).toBe(exchangeCountBeforeBindingChecks);

    const callback = await application.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=valid&state=${encodeURIComponent(request.state)}`,
      headers: { cookie: start.browserCookie },
    });
    expect(callback.statusCode).toBe(303);
    expect(callback.headers.location).toBe('/workspaces');
    const cookies = sessionCookies(callback.headers['set-cookie']);
    expect(String(callback.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(callback.headers['set-cookie'])).toContain('Secure');
    expect(String(callback.headers['set-cookie'])).toContain('SameSite=Lax');
    expect(cookies.rawSession).not.toBe(cookies.csrf);
    expect(provider.latestVerifier).toBeDefined();
    expect(sha256Base64Url(provider.latestVerifier ?? '')).toBe(
      request.codeChallenge,
    );

    const digest = sha256Hex(cookies.rawSession);
    const stored = await identityDatabase.findActiveSessionByDigest(digest);
    expect(stored).not.toBeNull();
    expect(stored?.tokenDigest).toBe(digest);
    expect(JSON.stringify(stored)).not.toContain(cookies.rawSession);

    const exchangeCount = provider.exchangeCount;
    const replay = await application.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=valid&state=${encodeURIComponent(request.state)}`,
      headers: { cookie: start.browserCookie },
    });
    expectProblem(replay, 400, 'request.invalid');
    expect(provider.exchangeCount).toBe(exchangeCount);

    const tampered = await application.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=valid&state=${'x'.repeat(43)}`,
      headers: { cookie: start.browserCookie },
    });
    expectProblem(tampered, 400, 'request.invalid');
    expect(provider.exchangeCount).toBe(exchangeCount);
  });

  it('authors and publishes a workflow through real auth, RLS, and ETags', async () => {
    const cookies = await login();
    await createPublishedWorkflow(cookies);
  });

  it('starts, replays, reads, cancels, and streams a durable workflow run', async () => {
    const cookies = await login();
    const { workspace, base, createdBody, publishedBody } =
      await createPublishedWorkflow(cookies);

    const runHeaders = mutationHeaders(cookies, {
      'idempotency-key': 'workflow-run-start-proof',
    });
    const started = await application.inject({
      method: 'POST',
      url: `${base}/${createdBody.workflow.id}/runs`,
      headers: runHeaders,
      payload: { input: { customerId: 'customer-42' } },
    });
    expect(started.statusCode).toBe(202);
    const startedBody = started.json<
      Readonly<{
        run: Readonly<{ id: string; status: string }>;
        replayed: boolean;
      }>
    >();
    expect(startedBody).toMatchObject({
      run: { status: 'queued' },
      replayed: false,
    });

    const startReplay = await application.inject({
      method: 'POST',
      url: `${base}/${createdBody.workflow.id}/runs`,
      headers: runHeaders,
      payload: { input: { customerId: 'customer-42' } },
    });
    expect(startReplay.statusCode).toBe(202);
    expect(startReplay.json()).toMatchObject({
      run: { id: startedBody.run.id },
      replayed: true,
    });
    const startConflict = await application.inject({
      method: 'POST',
      url: `${base}/${createdBody.workflow.id}/runs`,
      headers: runHeaders,
      payload: { input: { customerId: 'different' } },
    });
    expectProblem(startConflict, 409, 'request.idempotency_conflict');

    const runUrl = `/v1/workspaces/${workspace.id}/runs/${startedBody.run.id}`;

    const replayHeaders = mutationHeaders(cookies, {
      'idempotency-key': 'workflow-run-replay-proof',
    });
    const replayed = await application.inject({
      method: 'POST',
      url: `${runUrl}/replay`,
      headers: replayHeaders,
      payload: {
        workflowVersionId: publishedBody.version.id,
        input: { customerId: 'replay-customer-42' },
      },
    });
    expect(replayed.statusCode, replayed.payload).toBe(202);
    const replayedBody = replayed.json<
      Readonly<{
        run: Readonly<{
          id: string;
          status: string;
          triggerType: string;
          workflowVersionId: string;
        }>;
        replayed: boolean;
      }>
    >();
    expect(replayedBody).toMatchObject({
      run: {
        status: 'queued',
        triggerType: 'replay',
        workflowVersionId: publishedBody.version.id,
      },
      replayed: false,
    });
    expect(replayedBody.run.id).not.toBe(startedBody.run.id);

    const replayRetry = await application.inject({
      method: 'POST',
      url: `${runUrl}/replay`,
      headers: replayHeaders,
      payload: {
        workflowVersionId: publishedBody.version.id,
        input: { customerId: 'replay-customer-42' },
      },
    });
    expect(replayRetry.statusCode).toBe(202);
    expect(replayRetry.json()).toMatchObject({
      run: { id: replayedBody.run.id },
      replayed: true,
    });
    const replayConflict = await application.inject({
      method: 'POST',
      url: `${runUrl}/replay`,
      headers: replayHeaders,
      payload: {
        workflowVersionId: publishedBody.version.id,
        input: { customerId: 'different-replay-input' },
      },
    });
    expectProblem(replayConflict, 409, 'request.idempotency_conflict');

    for (const denial of [
      {
        statement:
          'update app.workspace_memberships set role=$2 where workspace_id=$1',
        denied: 'builder',
        restored: 'owner',
      },
      {
        statement: 'update app.workspaces set status=$2 where id=$1',
        denied: 'suspended',
        restored: 'active',
      },
    ]) {
      await withOwnerWorkspace(workspace.id, (client) =>
        client.query(denial.statement, [workspace.id, denial.denied]),
      );
      try {
        const forbiddenReplay = await application.inject({
          method: 'POST',
          url: `${runUrl}/replay`,
          headers: mutationHeaders(cookies, {
            'idempotency-key': `replay-denied-${denial.denied}`,
          }),
          payload: {
            workflowVersionId: publishedBody.version.id,
            input: { customerId: 'denied' },
          },
        });
        expectProblem(forbiddenReplay, 404, 'resource.not_found');
      } finally {
        await withOwnerWorkspace(workspace.id, (client) =>
          client.query(denial.statement, [workspace.id, denial.restored]),
        );
      }
    }

    const missingReplayCsrf = await application.inject({
      method: 'POST',
      url: `${runUrl}/replay`,
      headers: {
        cookie: cookies.cookieHeader,
        'idempotency-key': 'workflow-run-replay-missing-csrf',
      },
      payload: {
        workflowVersionId: publishedBody.version.id,
        input: { customerId: 'csrf-probe' },
      },
    });
    expectProblem(missingReplayCsrf, 403, 'auth.forbidden');

    const hiddenReplay = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${randomUUID()}/runs/${startedBody.run.id}/replay`,
      headers: mutationHeaders(cookies, {
        'idempotency-key': 'workflow-run-replay-hidden',
      }),
      payload: {
        workflowVersionId: publishedBody.version.id,
        input: { customerId: 'hidden-probe' },
      },
    });
    expectProblem(hiddenReplay, 404, 'resource.not_found');

    await archiveWorkflow(workspace.id, createdBody.workflow.id);
    const archivedReplay = await application.inject({
      method: 'POST',
      url: `${runUrl}/replay`,
      headers: mutationHeaders(cookies, {
        'idempotency-key': 'workflow-run-replay-archived',
      }),
      payload: {
        workflowVersionId: publishedBody.version.id,
        input: { customerId: 'archived-probe' },
      },
    });
    expectProblem(archivedReplay, 409, 'workflow.not_published');

    const readRun = await application.inject({
      method: 'GET',
      url: runUrl,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(readRun.statusCode).toBe(200);
    expect(readRun.json()).toMatchObject({
      run: {
        id: startedBody.run.id,
        workflowVersionId: publishedBody.version.id,
        workflowName: 'Inbound automation',
      },
      nodes: [],
    });
    const workflowMetadata = await application.inject({
      method: 'GET',
      url: `${base}/${createdBody.workflow.id}`,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(workflowMetadata.statusCode).toBe(200);
    expect(workflowMetadata.json()).toMatchObject({
      workflow: {
        id: createdBody.workflow.id,
        name: 'Inbound automation',
        lifecycleStatus: 'archived',
      },
    });
    const namedRuns = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${workspace.id}/runs?workflowNamePrefix=inbound`,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(namedRuns.statusCode).toBe(200);
    const namedRunsBody = workflowRunListResponseSchema.parse(namedRuns.json());
    expect(
      namedRunsBody.items.some(
        ({ id, workflowName }) =>
          id === startedBody.run.id && workflowName === 'Inbound automation',
      ),
    ).toBe(true);

    const canceled = await application.inject({
      method: 'POST',
      url: `${runUrl}/cancel`,
      headers: mutationHeaders(cookies),
      payload: { reason: 'operator request' },
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json()).toMatchObject({ alreadyRequested: false });
    const cancelReplay = await application.inject({
      method: 'POST',
      url: `${runUrl}/cancel`,
      headers: mutationHeaders(cookies),
      payload: { reason: 'operator request' },
    });
    expect(cancelReplay.statusCode).toBe(200);
    expect(cancelReplay.json()).toMatchObject({ alreadyRequested: true });

    const durableRunEffects = await workspaceDatabase.withWorkspace(
      workspace.id,
      async (transaction) => {
        const runs = await transaction.db.select().from(workflowRuns);
        const checkpoints = await transaction.db.select().from(runCheckpoints);
        const events = await transaction.db.select().from(runEvents);
        const outbox = await transaction.db.select().from(outboxEvents);
        return {
          runs: runs.filter(({ id }) => id === startedBody.run.id).length,
          checkpoints: checkpoints.filter(
            ({ workflowRunId }) => workflowRunId === startedBody.run.id,
          ).length,
          events: events.filter(
            ({ workflowRunId }) => workflowRunId === startedBody.run.id,
          ).length,
          outbox: outbox.filter(
            ({ aggregateId }) => aggregateId === startedBody.run.id,
          ).length,
        };
      },
    );
    expect(durableRunEffects).toEqual({
      runs: 1,
      checkpoints: 1,
      events: 2,
      outbox: 2,
    });

    const storedSession = await identityDatabase.findActiveSessionByDigest(
      sha256Hex(cookies.rawSession),
    );
    if (storedSession === null) throw new Error('Expected active session');
    const streamAbort = new AbortController();
    const frames = await application.get(StreamRunEventsUseCase).execute({
      actor: createActorContext({
        actorId: storedSession.userId,
        workspaceId: workspace.id,
        sessionId: storedSession.id,
        requestId: 'workflow-run-stream-proof',
      }),
      routeWorkspaceId: workspace.id,
      runId: startedBody.run.id,
      lastEventId: 1,
      sessionExpiresAt: storedSession.expiresAt,
      reauthorizeSession: () =>
        Promise.resolve({
          userId: storedSession.userId,
          sessionId: storedSession.id,
          expiresAt: storedSession.expiresAt,
        }),
      abortStream: (reason?: unknown) => {
        streamAbort.abort(reason);
      },
      signal: streamAbort.signal,
    });
    const iterator = frames[Symbol.asyncIterator]();
    let event: IteratorResult<unknown>;
    try {
      event = await withTimeout(iterator.next(), 2_000);
    } finally {
      streamAbort.abort();
      if (iterator.return !== undefined)
        await withTimeout(iterator.return(), 2_000);
    }
    const eventValue = event.value as Readonly<{
      id: number;
      event: string;
      data: string;
    }>;
    expect(eventValue).toMatchObject({
      id: 2,
      event: 'run.cancel_requested',
    });
    expect(eventValue.data).not.toContain('operator request');

    const hiddenRun = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${randomUUID()}/runs/${startedBody.run.id}`,
      headers: { cookie: cookies.cookieHeader },
    });
    expectProblem(hiddenRun, 404, 'resource.not_found');

    const hidden = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${randomUUID()}/workflows`,
      headers: { cookie: cookies.cookieHeader },
    });
    expectProblem(hidden, 404, 'resource.not_found');
  });

  it('rejects nonce mismatch and sanitizes provider failures as RFC 9457 problems', async () => {
    const nonceStart = await startLogin();
    const nonceState = new URL(nonceStart.authorizationUrl).searchParams.get(
      'state',
    );
    expect(nonceState).not.toBeNull();
    const nonceFailure = await application.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=bad-nonce&state=${encodeURIComponent(nonceState ?? '')}`,
      headers: { cookie: nonceStart.browserCookie },
    });
    expectProblem(nonceFailure, 400, 'request.invalid');
    expect(nonceFailure.payload).not.toContain('forged-nonce');

    const providerStart = await startLogin();
    const providerState = new URL(
      providerStart.authorizationUrl,
    ).searchParams.get('state');
    const providerFailure = await application.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=provider-failure&state=${encodeURIComponent(providerState ?? '')}`,
      headers: { cookie: providerStart.browserCookie },
    });
    expectProblem(providerFailure, 503, 'provider.unavailable');
    expect(providerFailure.payload).not.toContain(
      'provider-secret-must-never-leak',
    );
  });

  it('enforces CSRF and atomically creates an owner membership and correlated audit fact', async () => {
    const cookies = await login();
    const slug = `phase1-${randomUUID().slice(0, 12)}`;
    const missingCsrf = await application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: { cookie: cookies.cookieHeader },
      payload: { name: 'Rejected Workspace', slug: `${slug}-rejected` },
    });
    expectProblem(missingCsrf, 403, 'auth.forbidden');

    const requestId = `phase1-create-${randomUUID()}`;
    const traceId = randomUUID().replaceAll('-', '');
    const creationKey = `create-${randomUUID()}`;
    const created = await application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies, {
        'x-request-id': requestId,
        'idempotency-key': creationKey,
        traceparent: `00-${traceId}-0123456789abcdef-01`,
      }),
      payload: { name: 'Phase One Workspace', slug },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['x-request-id']).toBe(requestId);
    const workspace = created.json<{ id: string; status: string }>();
    expect(workspace.status).toBe('active');

    const discovered = await application.inject({
      method: 'GET',
      url: '/v1/workspaces?limit=100',
      headers: { cookie: cookies.cookieHeader },
    });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.headers['cache-control']).toBe('private, no-store');
    const discoveredItems = discovered.json<{
      items: { id: string; role: string; capabilities: string[] }[];
    }>().items;
    const discoveredWorkspace = discoveredItems.find(
      (item) => item.id === workspace.id,
    );
    expect(discoveredWorkspace).toMatchObject({
      id: workspace.id,
      role: 'owner',
    });
    expect(discoveredWorkspace?.capabilities).toEqual(
      expect.arrayContaining(['workspace:manage', 'workflow:create']),
    );

    const creationRetry = await application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies, {
        'idempotency-key': creationKey,
      }),
      payload: { name: 'Phase One Workspace', slug },
    });
    expect(creationRetry.statusCode).toBe(201);
    expect(creationRetry.json()).toEqual(created.json());
    const changedCreation = await application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies, {
        'idempotency-key': creationKey,
      }),
      payload: { name: 'Changed Workspace', slug },
    });
    expectProblem(changedCreation, 409, 'request.idempotency_conflict');

    const aggregate = await workspaceAggregate(workspace.id);
    expect(aggregate.memberships).toHaveLength(1);
    expect(aggregate.memberships[0]).toMatchObject({ role: 'owner' });
    expect(aggregate.events).toHaveLength(1);
    expect(aggregate.events[0]).toMatchObject({
      action: 'workspace.created',
      requestId,
      traceId,
    });

    const duplicate = await application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies),
      payload: { name: 'Duplicate Workspace', slug },
    });
    expectProblem(duplicate, 409, 'workspace.conflict');
    const unchanged = await workspaceAggregate(workspace.id);
    expect(unchanged.memberships).toHaveLength(1);
    expect(unchanged.events).toHaveLength(1);

    const forgedRole = await application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies),
      payload: { name: 'Forged Role', slug: `${slug}-forged`, role: 'owner' },
    });
    expectProblem(forgedRole, 400, 'request.invalid');

    const forgedWorkspace = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${randomUUID()}/deletion`,
      headers: mutationHeaders(cookies),
      payload: { reason: 'forged workspace context' },
    });
    expectProblem(forgedWorkspace, 403, 'auth.forbidden');
  });

  it('conditionally renames a workspace and safely reconciles lost acknowledgements', async () => {
    const cookies = await login();
    const targetId = await createWorkspace(cookies, 'Rename proof');
    const firstKey = `rename-${randomUUID()}`;
    const missingCsrf = await application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: {
        cookie: cookies.cookieHeader,
        'idempotency-key': firstKey,
      },
      payload: { name: 'Rejected rename', expectedRevision: 1 },
    });
    expectProblem(missingCsrf, 403, 'auth.forbidden');

    const renamed = await application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies, { 'idempotency-key': firstKey }),
      payload: { name: 'Authoritative rename', expectedRevision: 1 },
    });
    expect(renamed.statusCode, renamed.payload).toBe(200);
    expect(renamed.json()).toMatchObject({
      workspace: {
        id: targetId,
        name: 'Authoritative rename',
        revision: 2,
      },
      changed: true,
      replayed: false,
    });
    const exactRetry = await application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies, { 'idempotency-key': firstKey }),
      payload: { name: 'Authoritative rename', expectedRevision: 1 },
    });
    expect(exactRetry.statusCode, exactRetry.payload).toBe(200);
    expect(exactRetry.json()).toMatchObject({ replayed: true });

    const newer = await application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies),
      payload: { name: 'Newer tab rename', expectedRevision: 2 },
    });
    expect(newer.statusCode, newer.payload).toBe(200);
    const historicalRetry = await application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies, { 'idempotency-key': firstKey }),
      payload: { name: 'Authoritative rename', expectedRevision: 1 },
    });
    expect(historicalRetry.statusCode, historicalRetry.payload).toBe(200);
    expect(historicalRetry.json()).toMatchObject({ replayed: true });

    const discovery = await application.inject({
      method: 'GET',
      url: '/v1/workspaces?limit=100',
      headers: { cookie: cookies.cookieHeader },
    });
    expect(
      discovery
        .json<{ items: { id: string; name: string; revision: number }[] }>()
        .items.find((item) => item.id === targetId),
    ).toMatchObject({ name: 'Newer tab rename', revision: 3 });
    const stale = await application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies),
      payload: { name: 'Stale overwrite', expectedRevision: 2 },
    });
    expectProblem(stale, 412, 'workspace.revision_conflict');
    const changedExactRetry = await application.inject({
      method: 'PATCH',
      url: `/v1/workspaces/${targetId}`,
      headers: mutationHeaders(cookies, { 'idempotency-key': firstKey }),
      payload: { name: 'Changed command', expectedRevision: 1 },
    });
    expectProblem(changedExactRetry, 409, 'request.idempotency_conflict');
  });

  it('accepts and exposes one safe asynchronous deletion operation without projecting state', async () => {
    const deletionCookies = await login();
    const primaryWorkspaceId = await createWorkspace(
      deletionCookies,
      'Deletion Proof',
    );
    const deletionRequestId = `phase1-delete-${randomUUID()}`;
    const deletionKey = `delete-${randomUUID()}`;
    const deletion = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/deletion`,
      headers: mutationHeaders(deletionCookies, {
        'x-request-id': deletionRequestId,
        'idempotency-key': deletionKey,
      }),
      payload: { reason: 'customer requested integration deletion' },
    });
    expect(deletion.statusCode).toBe(202);
    expect(deletion.json()).toMatchObject({
      workspaceId: primaryWorkspaceId,
      commandType: 'deletion_requested',
      status: 'pending',
      completedAt: null,
      errorCode: null,
      result: null,
    });
    const operationId = deletion.json<{ id: string }>().id;
    expect(deletion.payload).not.toContain(
      'customer requested integration deletion',
    );
    expect(deletion.payload).not.toContain('controlSequence');
    expect(deletion.payload).not.toContain('controlRecordHash');

    const deletionRetry = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/deletion`,
      headers: mutationHeaders(deletionCookies, {
        'idempotency-key': deletionKey,
      }),
      payload: { reason: 'customer requested integration deletion' },
    });
    expect(deletionRetry.statusCode).toBe(202);
    expect(deletionRetry.json()).toEqual(deletion.json());

    const operation = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${primaryWorkspaceId}/lifecycle-operations/${operationId}`,
      headers: { cookie: deletionCookies.cookieHeader },
    });
    expect(operation.statusCode).toBe(200);
    expect(operation.json()).toEqual(deletion.json());

    const unchanged = await workspaceAggregate(primaryWorkspaceId);
    expect(unchanged.workspace).toMatchObject({
      status: 'active',
      deletionReason: null,
    });
    expect(unchanged.events.map(({ action }) => action)).toEqual([
      'workspace.created',
    ]);

    const changedReplay = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/deletion`,
      headers: mutationHeaders(deletionCookies, {
        'idempotency-key': deletionKey,
      }),
      payload: { reason: 'changed deletion request' },
    });
    expectProblem(changedReplay, 409, 'request.idempotency_conflict');

    const restoreKey = `restore-${randomUUID()}`;
    const restore = await application.inject({
      method: 'DELETE',
      url: `/v1/workspaces/${primaryWorkspaceId}/deletion`,
      headers: mutationHeaders(deletionCookies, {
        'idempotency-key': restoreKey,
      }),
    });
    expectProblem(restore, 409, 'workspace.conflict');
  });

  it('serves a private current-user projection and bounded authorized member pages', async () => {
    const cookies = await login();
    const primaryWorkspaceId = await createWorkspace(cookies, 'Member Proof');
    const unauthenticated = await application.inject({
      method: 'GET',
      url: '/v1/users/me',
    });
    expectProblem(unauthenticated, 401, 'auth.unauthenticated');
    const profile = await application.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { cookie: cookies.cookieHeader },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.headers['cache-control']).toBe('private, no-store');
    expect(profile.json()).toMatchObject({
      email: 'phase1-real-stack@example.test',
      displayName: 'Phase One Real Stack',
      status: 'active',
    });
    expect(profile.json()).not.toHaveProperty('profileMetadata');

    const memberA = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Member A',
    });
    const memberB = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Member B',
    });
    await withOwnerWorkspace(primaryWorkspaceId, (client) =>
      client.query(
        `insert into app.workspace_memberships (workspace_id, user_id, role, status)
         values ($1, $2, 'viewer', 'active'), ($1, $3, 'viewer', 'active')`,
        [primaryWorkspaceId, memberA.id, memberB.id],
      ),
    );

    const first = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${primaryWorkspaceId}/members?limit=1`,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, no-store');
    const firstBody = first.json<{
      items: unknown[];
      nextCursor: string | null;
    }>();
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.nextCursor).toBeTruthy();
    const second = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${primaryWorkspaceId}/members?limit=1&after=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(
      second.json<{ items: { userId: string }[] }>().items[0]?.userId,
    ).not.toBe((firstBody.items[0] as { userId: string }).userId);

    const crossTenant = await application.inject({
      method: 'GET',
      url: `/v1/workspaces/${randomUUID()}/members`,
      headers: { cookie: cookies.cookieHeader },
    });
    expectProblem(crossTenant, 403, 'auth.forbidden');

    const { base, createdBody } = await createPublishedWorkflow(
      cookies,
      primaryWorkspaceId,
    );
    const started = await application.inject({
      method: 'POST',
      url: `${base}/${createdBody.workflow.id}/runs`,
      headers: mutationHeaders(cookies, {
        'idempotency-key': `role-revocation-run-${randomUUID()}`,
      }),
      payload: { input: { source: 'role-revocation-proof' } },
    });
    expect(started.statusCode, started.payload).toBe(202);
    const runId = started.json<{ run: { id: string } }>().run.id;
    const runUrl = `/v1/workspaces/${primaryWorkspaceId}/runs/${runId}`;

    const rawTargetSession = `${randomUUID()}${randomUUID()}`;
    await identityDatabase.createSession({
      userId: memberA.id,
      tokenDigest: sha256Hex(rawTargetSession),
      expiresAt: new Date(identityNow.getTime() + 60_000),
    });
    const targetCookie = `pertexo_session=${rawTargetSession}`;
    const beforeChange = await application.inject({
      method: 'GET',
      url: runUrl,
      headers: { cookie: targetCookie },
    });
    expect(beforeChange.statusCode, beforeChange.payload).toBe(200);

    await application.listen(0, '127.0.0.1');
    const address = application.getHttpServer().address() as { port: number };
    const openStream = openHttpEventStream(
      address.port,
      `${runUrl}/events`,
      targetCookie,
      1,
    );
    await withTimeout(openStream.started, 2_000);

    const roleHeaders = mutationHeaders(cookies, {
      'idempotency-key': `member-role-${randomUUID()}`,
    });
    try {
      const roleChange = await application.inject({
        method: 'POST',
        url: `/v1/workspaces/${primaryWorkspaceId}/members/${memberA.id}/role`,
        headers: roleHeaders,
        payload: { role: 'operator', expectedRoleRevision: 1 },
      });
      expect(roleChange.statusCode).toBe(200);
      expect(roleChange.json()).toEqual({
        userId: memberA.id,
        role: 'operator',
        roleRevision: 2,
        changed: true,
        replayed: false,
      });
      await expect(
        identityDatabase.findActiveSessionByDigest(sha256Hex(rawTargetSession)),
      ).resolves.toBeNull();
      const afterChange = await application.inject({
        method: 'GET',
        url: runUrl,
        headers: { cookie: targetCookie },
      });
      expectProblem(afterChange, 401, 'auth.unauthenticated');
      await withTimeout(openStream.closed, 6_500);
    } finally {
      openStream.request.destroy();
    }
    const replay = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/members/${memberA.id}/role`,
      headers: roleHeaders,
      payload: { role: 'operator', expectedRoleRevision: 1 },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, roleRevision: 2 });
    const stale = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${primaryWorkspaceId}/members/${memberA.id}/role`,
      headers: mutationHeaders(cookies),
      payload: { role: 'viewer', expectedRoleRevision: 1 },
    });
    expectProblem(stale, 409, 'workspace.member_role_revision_conflict');
  }, 15_000);

  it('rejects explicitly revoked and expired sessions without exposing cookie values', async () => {
    const logoutCookies = await login();
    const logout = await application.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: mutationHeaders(logoutCookies),
    });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
    const afterLogout = await authenticatedMutation(logoutCookies);
    expectProblem(afterLogout, 401, 'auth.unauthenticated');
    expect(afterLogout.payload).not.toContain(logoutCookies.rawSession);

    const expiringCookies = await login();
    identityNow = new Date(identityNow.getTime() + 120_100);
    const expired = await authenticatedMutation(expiringCookies);
    expectProblem(expired, 401, 'auth.unauthenticated');
    expect(expired.payload).not.toContain(expiringCookies.rawSession);
  });

  it('accepts a delivered invitation once, rotates the recipient session, and closes an existing SSE stream', async () => {
    const ownerProfile = provider.profile;
    const manager = await identityDatabase.createUser({
      email: `${randomUUID()}@example.test`,
      displayName: 'Invitation integration manager',
    });
    const managerRawSession = `${randomUUID()}${randomUUID()}`;
    await identityDatabase.createSession({
      userId: manager.id,
      tokenDigest: sha256Hex(managerRawSession),
      expiresAt: new Date(identityNow.getTime() + 120_000),
    });
    const managerCsrf = sha256Base64Url(randomUUID());
    const managerCookies = {
      rawSession: managerRawSession,
      csrf: managerCsrf,
      cookieHeader: `pertexo_session=${managerRawSession}; pertexo_csrf=${managerCsrf}`,
    };
    const invitedWorkspaceId = await createWorkspace(
      managerCookies,
      'Invitation acceptance proof',
    );
    const streamWorkspaceId = await createWorkspace(
      managerCookies,
      'Invitation stream proof',
    );
    const { base, createdBody } = await createPublishedWorkflow(
      managerCookies,
      streamWorkspaceId,
    );
    const started = await application.inject({
      method: 'POST',
      url: `${base}/${createdBody.workflow.id}/runs`,
      headers: mutationHeaders(managerCookies, {
        'idempotency-key': `invitation-run-${randomUUID()}`,
      }),
      payload: { input: { source: 'invitation-session-proof' } },
    });
    expect(started.statusCode, started.payload).toBe(202);
    const runId = started.json<{ run: { id: string } }>().run.id;
    const runUrl = `/v1/workspaces/${streamWorkspaceId}/runs/${runId}`;
    const recipientEmail = `${randomUUID()}@example.test`;
    const createdInvitation = await application.inject({
      method: 'POST',
      url: `/v1/workspaces/${invitedWorkspaceId}/invitations`,
      headers: mutationHeaders(managerCookies, {
        'idempotency-key': `invitation-create-${randomUUID()}`,
      }),
      payload: { email: recipientEmail, role: 'viewer' },
    });
    expect(createdInvitation.statusCode, createdInvitation.payload).toBe(202);
    const invitationId = createdInvitation.json<{
      invitation: { id: string };
    }>().invitation.id;
    let invitationToken = '';
    await withOwnerWorkspace(invitedWorkspaceId, async (client) => {
      const delivery = await client.query<{
        id: string;
        token_ciphertext: string;
        token_nonce: string;
        token_tag: string;
        token_key_version: string;
      }>(
        `select id,token_ciphertext,token_nonce,token_tag,token_key_version
           from app.workspace_invitation_delivery_attempts
          where workspace_id=$1 and invitation_id=$2`,
        [invitedWorkspaceId, invitationId],
      );
      const row = delivery.rows[0];
      if (row === undefined)
        throw new Error('Invitation delivery was not stored');
      const identityConfig = config().identity;
      if (identityConfig === undefined)
        throw new Error('Identity configuration is missing');
      invitationToken = createApplicationSecretEnvelope(
        identityConfig.invitationTokenEncryption ??
          identityConfig.secretEncryption,
      ).open(
        {
          ciphertext: row.token_ciphertext,
          nonce: row.token_nonce,
          tag: row.token_tag,
          keyVersion: row.token_key_version,
        },
        `pertexo/workspace-invitation/${invitedWorkspaceId}/${invitationId}/${row.id}`,
      );
    });

    const resolved = await application.inject({
      method: 'POST',
      url: '/v1/invitation-acceptance/resolve',
      remoteAddress: '198.51.100.25',
      headers: {
        origin: 'https://api.integration.test',
        'content-type': 'application/json',
        'x-pertexo-invitation-request': 'resolve',
      },
      payload: { token: invitationToken },
    });
    expect(resolved.statusCode, resolved.payload).toBe(201);
    let resolvedBody = resolved.json<{
      state: string;
      intentId: string;
      csrfToken: string;
    }>();
    expect(resolvedBody.state).toBe('sign_in_required');
    const originalInvitationBinding = cookieValue(
      Array.isArray(resolved.headers['set-cookie'])
        ? resolved.headers['set-cookie']
        : [String(resolved.headers['set-cookie'])],
      'pertexo_invitation_intent',
    );
    const lostReplacement = await application.inject({
      method: 'POST',
      url: '/v1/invitation-acceptance/resolve',
      remoteAddress: '198.51.100.25',
      headers: {
        cookie: `pertexo_invitation_intent=${encodeURIComponent(originalInvitationBinding)}`,
        origin: 'https://api.integration.test',
        'content-type': 'application/json',
        'x-pertexo-invitation-request': 'resolve',
      },
      payload: { token: invitationToken },
    });
    expect(lostReplacement.statusCode, lostReplacement.payload).toBe(201);
    const lostReplacementBody = lostReplacement.json<{
      state: string;
      intentId: string;
      csrfToken: string;
    }>();
    const lostReplacementBinding = cookieValue(
      Array.isArray(lostReplacement.headers['set-cookie'])
        ? lostReplacement.headers['set-cookie']
        : [String(lostReplacement.headers['set-cookie'])],
      'pertexo_invitation_intent',
    );
    const recoveredReplacement = await application.inject({
      method: 'POST',
      url: '/v1/invitation-acceptance/resolve',
      remoteAddress: '198.51.100.25',
      headers: {
        cookie: `pertexo_invitation_intent=${encodeURIComponent(originalInvitationBinding)}`,
        origin: 'https://api.integration.test',
        'content-type': 'application/json',
        'x-pertexo-invitation-request': 'resolve',
      },
      payload: { token: invitationToken },
    });
    expect(recoveredReplacement.statusCode, recoveredReplacement.payload).toBe(
      201,
    );
    expect(recoveredReplacement.json()).toEqual(lostReplacementBody);
    const invitationBinding = cookieValue(
      Array.isArray(recoveredReplacement.headers['set-cookie'])
        ? recoveredReplacement.headers['set-cookie']
        : [String(recoveredReplacement.headers['set-cookie'])],
      'pertexo_invitation_intent',
    );
    expect(invitationBinding).toBe(lostReplacementBinding);
    resolvedBody = lostReplacementBody;
    const oidcStart = await application.inject({
      method: 'POST',
      url: '/v1/invitation-acceptance/oidc',
      remoteAddress: '198.51.100.25',
      headers: {
        cookie: `pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
        'x-invitation-csrf-token': resolvedBody.csrfToken,
      },
      payload: {},
    });
    expect(oidcStart.statusCode, oidcStart.payload).toBe(200);
    const oidcState = new URL(
      oidcStart.json<{ authorizationUrl: string }>().authorizationUrl,
    ).searchParams.get('state');
    if (oidcState === null) throw new Error('Invitation OIDC state is missing');
    const oidcBinding = cookieValue(
      Array.isArray(oidcStart.headers['set-cookie'])
        ? oidcStart.headers['set-cookie']
        : [String(oidcStart.headers['set-cookie'])],
      'pertexo_oidc_binding',
    );

    provider.profile = {
      subject: `invited-${randomUUID()}`,
      email: recipientEmail,
      displayName: 'Invited integration recipient',
      emailVerified: true,
    };
    let openStream: ReturnType<typeof openHttpEventStream> | undefined;
    try {
      const callback = await application.inject({
        method: 'GET',
        url: `/v1/auth/oidc/callback?code=valid&state=${encodeURIComponent(oidcState)}`,
        headers: {
          cookie: `pertexo_oidc_binding=${encodeURIComponent(oidcBinding)}`,
        },
      });
      expect(callback.statusCode, callback.payload).toBe(303);
      expect(callback.headers.location).toBe('/invitations/accept');
      const recipientCookies = sessionCookies(callback.headers['set-cookie']);
      const recipientSession = await identityDatabase.findActiveSessionByDigest(
        sha256Hex(recipientCookies.rawSession),
      );
      if (recipientSession === null)
        throw new Error('Invitation recipient session is unavailable');
      await withOwnerWorkspace(streamWorkspaceId, (client) =>
        client.query(
          `insert into app.workspace_memberships(workspace_id,user_id,role,status)
           values($1,$2,'viewer','active')`,
          [streamWorkspaceId, recipientSession.userId],
        ),
      );
      const beforeAcceptance = await application.inject({
        method: 'GET',
        url: runUrl,
        headers: { cookie: recipientCookies.cookieHeader },
      });
      expect(beforeAcceptance.statusCode, beforeAcceptance.payload).toBe(200);
      if (!application.getHttpServer().listening)
        await application.listen(0, '127.0.0.1');
      const address = application.getHttpServer().address() as { port: number };
      openStream = openHttpEventStream(
        address.port,
        `${runUrl}/events`,
        recipientCookies.cookieHeader,
        1,
      );
      await withTimeout(openStream.started, 2_000);

      const ready = await application.inject({
        method: 'GET',
        url: '/v1/invitation-acceptance',
        headers: {
          cookie: `${recipientCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
        },
      });
      expect(ready.statusCode, ready.payload).toBe(200);
      const readyBody = ready.json<{
        state: string;
        intentId: string;
        csrfToken: string;
        invitationRevision: number;
      }>();
      expect(readyBody).toMatchObject({
        state: 'ready',
        intentId: resolvedBody.intentId,
        csrfToken: resolvedBody.csrfToken,
        invitationRevision: 1,
      });
      const acceptanceKey = `invitation-accept-${randomUUID()}`;
      const completed = await application.inject({
        method: 'POST',
        url: '/v1/invitation-acceptance/complete',
        headers: mutationHeaders(recipientCookies, {
          cookie: `${recipientCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
          'idempotency-key': acceptanceKey,
          'x-invitation-csrf-token': readyBody.csrfToken,
        }),
        payload: {
          intentId: readyBody.intentId,
          expectedRevision: readyBody.invitationRevision,
        },
      });
      expect(completed.statusCode, completed.payload).toBe(200);
      expect(completed.json()).toMatchObject({
        workspaceId: invitedWorkspaceId,
        membershipCreated: true,
        role: 'viewer',
      });
      const replacementCookies = sessionCookies(
        completed.headers['set-cookie'],
      );
      expect(String(completed.headers['set-cookie'])).not.toContain(
        'pertexo_invitation_intent=;',
      );
      const reconciledWithReplacement = await application.inject({
        method: 'GET',
        url: '/v1/invitation-acceptance',
        headers: {
          cookie: `${replacementCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
        },
      });
      expect(reconciledWithReplacement.statusCode).toBe(200);
      expect(reconciledWithReplacement.json()).toMatchObject({
        state: 'completed',
        workspace: { id: invitedWorkspaceId },
      });
      const oldSession = await application.inject({
        method: 'GET',
        url: runUrl,
        headers: { cookie: recipientCookies.cookieHeader },
      });
      expectProblem(oldSession, 401, 'auth.unauthenticated');
      await withTimeout(openStream.closed, 6_500);

      const recoveryRequired = await application.inject({
        method: 'GET',
        url: '/v1/invitation-acceptance',
        headers: {
          cookie: `pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
        },
      });
      expect(recoveryRequired.statusCode, recoveryRequired.payload).toBe(200);
      expect(recoveryRequired.json()).toMatchObject({
        state: 'sign_in_required',
        intentId: readyBody.intentId,
      });

      const recoveryStart = await application.inject({
        method: 'POST',
        url: '/v1/invitation-acceptance/oidc',
        headers: {
          cookie: `pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
          'x-invitation-csrf-token': readyBody.csrfToken,
        },
        payload: {},
      });
      expect(recoveryStart.statusCode, recoveryStart.payload).toBe(200);
      const recoveryState = new URL(
        recoveryStart.json<{ authorizationUrl: string }>().authorizationUrl,
      ).searchParams.get('state');
      if (recoveryState === null)
        throw new Error('Invitation recovery OIDC state is missing');
      const recoveryBinding = cookieValue(
        Array.isArray(recoveryStart.headers['set-cookie'])
          ? recoveryStart.headers['set-cookie']
          : [String(recoveryStart.headers['set-cookie'])],
        'pertexo_oidc_binding',
      );
      const recoveryCallback = await application.inject({
        method: 'GET',
        url: `/v1/auth/oidc/callback?code=valid&state=${encodeURIComponent(recoveryState)}`,
        headers: {
          cookie: `pertexo_oidc_binding=${encodeURIComponent(recoveryBinding)}`,
        },
      });
      expect(recoveryCallback.statusCode, recoveryCallback.payload).toBe(303);
      const recoveredCookies = sessionCookies(
        recoveryCallback.headers['set-cookie'],
      );
      const reconciledAfterLostCookies = await application.inject({
        method: 'GET',
        url: '/v1/invitation-acceptance',
        headers: {
          cookie: `${recoveredCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
        },
      });
      expect(reconciledAfterLostCookies.statusCode).toBe(200);
      expect(reconciledAfterLostCookies.json()).toMatchObject({
        state: 'completed',
        workspace: { id: invitedWorkspaceId },
      });
      const changedExactRetry = await application.inject({
        method: 'POST',
        url: '/v1/invitation-acceptance/complete',
        headers: mutationHeaders(recoveredCookies, {
          cookie: `${recoveredCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
          'idempotency-key': acceptanceKey,
          'x-invitation-csrf-token': readyBody.csrfToken,
        }),
        payload: {
          intentId: readyBody.intentId,
          expectedRevision: readyBody.invitationRevision + 1,
        },
      });
      expectProblem(changedExactRetry, 409, 'request.idempotency_conflict');
      const historicalRecovery = await application.inject({
        method: 'POST',
        url: '/v1/invitation-acceptance/complete',
        headers: mutationHeaders(recoveredCookies, {
          cookie: `${recoveredCookies.cookieHeader}; pertexo_invitation_intent=${encodeURIComponent(invitationBinding)}`,
          'idempotency-key': `invitation-recovery-${randomUUID()}`,
          'x-invitation-csrf-token': readyBody.csrfToken,
        }),
        payload: {
          intentId: readyBody.intentId,
          expectedRevision: readyBody.invitationRevision + 1,
        },
      });
      expect(historicalRecovery.statusCode, historicalRecovery.payload).toBe(
        200,
      );
      expect(historicalRecovery.json()).toMatchObject({
        replayed: true,
        membershipCreated: true,
      });
      const granted = await application.inject({
        method: 'GET',
        url: '/v1/workspaces',
        headers: { cookie: replacementCookies.cookieHeader },
      });
      expect(granted.statusCode, granted.payload).toBe(200);
      expect(
        granted
          .json<{ items: { id: string; role: string }[] }>()
          .items.find((item) => item.id === invitedWorkspaceId),
      ).toMatchObject({ id: invitedWorkspaceId, role: 'viewer' });
      const aggregate = await workspaceAggregate(invitedWorkspaceId);
      expect(
        aggregate.events.filter(
          (event) => event.action === 'workspace.invitation_accepted',
        ),
      ).toHaveLength(1);
    } finally {
      openStream?.request.destroy();
      provider.profile = ownerProfile;
    }
  }, 20_000);

  async function startLogin(): Promise<{
    authorizationUrl: string;
    expiresAt: string;
    browserCookie: string;
  }> {
    loginAttempt += 1;
    const response = await application.inject({
      method: 'GET',
      url: '/v1/auth/oidc/start',
      remoteAddress: `198.51.100.${String(30 + loginAttempt)}`,
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json<{
      authorizationUrl: string;
      expiresAt: string;
    }>();
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('Path=/v1/auth/oidc/callback');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=30');
    const browserBinding = cookieValue([setCookie], 'pertexo_oidc_binding');
    expect(response.payload).not.toContain(browserBinding);
    return {
      ...payload,
      browserCookie: `pertexo_oidc_binding=${encodeURIComponent(browserBinding)}`,
    };
  }

  async function login(): Promise<SessionCookies> {
    const start = await startLogin();
    const state = new URL(start.authorizationUrl).searchParams.get('state');
    if (state === null) throw new Error('OIDC state was not returned');
    const response = await application.inject({
      method: 'GET',
      url: `/v1/auth/oidc/callback?code=valid&state=${encodeURIComponent(state)}`,
      headers: { cookie: start.browserCookie },
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/workspaces');
    return sessionCookies(response.headers['set-cookie']);
  }

  async function createPublishedWorkflow(
    cookies: SessionCookies,
    existingWorkspaceId?: string,
  ) {
    const fixtureId = randomUUID();
    const workspace =
      existingWorkspaceId === undefined
        ? await createWorkflowWorkspace(cookies, fixtureId)
        : { id: existingWorkspaceId };
    const base = `/v1/workspaces/${workspace.id}/workflows`;

    const created = await application.inject({
      method: 'POST',
      url: base,
      headers: mutationHeaders(cookies, {
        'idempotency-key': `workflow-create-${fixtureId}`,
      }),
      payload: { name: 'Inbound automation' },
    });
    expect(created.statusCode, created.payload).toBe(201);
    expect(String(created.headers.etag)).toMatch(
      /^"draft-v1\.[A-Za-z0-9_-]{43}"$/u,
    );
    const createdBody = created.json<
      Readonly<{
        workflow: Readonly<{ id: string }>;
        draft: Readonly<{ revision: number }>;
      }>
    >();
    expect(createdBody.draft.revision).toBe(1);

    const listed = await application.inject({
      method: 'GET',
      url: `${base}?limit=1`,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      items: [{ id: createdBody.workflow.id }],
    });

    const draftUrl = `${base}/${createdBody.workflow.id}/draft`;
    const firstDraft = await application.inject({
      method: 'GET',
      url: draftUrl,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(firstDraft.statusCode).toBe(200);
    const firstTag = String(firstDraft.headers.etag);
    expect(firstTag).toMatch(/^"draft-v1\.[A-Za-z0-9_-]{43}"$/u);

    const missingPrecondition = await application.inject({
      method: 'PUT',
      url: draftUrl,
      headers: mutationHeaders(cookies),
      payload: { graph: emptyWorkflowGraph() },
    });
    expectProblem(missingPrecondition, 428, 'request.precondition_required');

    const saved = await application.inject({
      method: 'PUT',
      url: draftUrl,
      headers: mutationHeaders(cookies, { 'if-match': firstTag }),
      payload: { graph: emptyWorkflowGraph() },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ revision: 2 });
    const secondTag = String(saved.headers.etag);
    expect(secondTag).not.toBe(firstTag);

    const stale = await application.inject({
      method: 'PUT',
      url: draftUrl,
      headers: mutationHeaders(cookies, { 'if-match': firstTag }),
      payload: { graph: emptyWorkflowGraph() },
    });
    expectProblem(stale, 412, 'workflow.revision_conflict');
    expect(stale.headers.etag).toBe(secondTag);
    expect(stale.json()).toMatchObject({
      currentRevision: 2,
      currentEtag: secondTag,
    });

    const validated = await application.inject({
      method: 'POST',
      url: `${base}/${createdBody.workflow.id}/validate`,
      headers: mutationHeaders(cookies),
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.json()).toMatchObject({ valid: true, issues: [] });

    const publishHeaders = mutationHeaders(cookies, {
      'idempotency-key': `workflow-publish-${fixtureId}`,
      'if-match': secondTag,
    });
    const published = await application.inject({
      method: 'POST',
      url: `${base}/${createdBody.workflow.id}/publish`,
      headers: publishHeaders,
    });
    expect(published.statusCode).toBe(200);
    const publishedBody =
      published.json<Readonly<{ version: Readonly<{ id: string }> }>>();

    const replay = await application.inject({
      method: 'POST',
      url: `${base}/${createdBody.workflow.id}/publish`,
      headers: publishHeaders,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      version: { id: publishedBody.version.id },
    });

    const versions = await application.inject({
      method: 'GET',
      url: `${base}/${createdBody.workflow.id}/versions`,
      headers: { cookie: cookies.cookieHeader },
    });
    expect(versions.statusCode).toBe(200);
    expect(versions.json()).toMatchObject({
      items: [{ id: publishedBody.version.id }],
    });

    return { workspace, base, createdBody, publishedBody } as const;
  }

  async function createWorkflowWorkspace(
    cookies: SessionCookies,
    fixtureId: string,
  ): Promise<Readonly<{ id: string }>> {
    const response = await application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies),
      payload: {
        name: 'Workflow Proof',
        slug: `workflow-proof-${fixtureId.slice(0, 12)}`,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<Readonly<{ id: string }>>();
  }

  async function authenticatedMutation(cookies: SessionCookies) {
    return application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies),
      payload: {
        name: 'Session Probe',
        slug: `session-probe-${randomUUID().slice(0, 12)}`,
      },
    });
  }

  async function createWorkspace(
    cookies: SessionCookies,
    name: string,
  ): Promise<string> {
    const response = await application.inject({
      method: 'POST',
      url: '/v1/workspaces',
      headers: mutationHeaders(cookies),
      payload: {
        name,
        slug: `${name.toLowerCase().replaceAll(' ', '-')}-${randomUUID().slice(0, 12)}`,
      },
    });
    expect(response.statusCode, response.payload).toBe(201);
    return response.json<Readonly<{ id: string }>>().id;
  }

  async function workspaceAggregate(workspaceId: string) {
    return workspaceDatabase.withWorkspace(workspaceId, async ({ db }) => {
      const workspaceRows = await db.select().from(workspaces);
      return {
        events: await db.select().from(auditEvents),
        memberships: await db.select().from(workspaceMemberships),
        workspace: workspaceRows.find((row) => row.id === workspaceId),
      };
    });
  }

  function requireAuthorizationRequest(): OidcAuthorizationRequest {
    const request = provider.latestRequest;
    if (request === undefined) throw new Error('OIDC request was not captured');
    return request;
  }

  async function archiveWorkflow(
    workspaceId: string,
    workflowId: string,
  ): Promise<void> {
    await withOwnerWorkspace(workspaceId, (client) =>
      client.query(
        `update app.workflows set lifecycle_status='archived' where id=$1`,
        [workflowId],
      ),
    );
  }

  async function withOwnerWorkspace(
    workspaceId: string,
    work: (client: PoolClient) => Promise<unknown>,
  ): Promise<void> {
    const pool = new Pool({
      connectionString:
        process.env.DATABASE_MIGRATION_URL ??
        'postgresql://invalid:invalid@localhost/invalid',
      max: 1,
    });
    try {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `set local role "${ownerRole.replaceAll('"', '""')}"`,
        );
        await client.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await work(client);
        await client.query('commit');
      } catch (error: unknown) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  }
});

function config(): ApiConfig {
  return {
    database: databaseConfig,
    host: '127.0.0.1',
    identity: {
      oidc: {
        issuer,
        authorizationEndpoint: `${issuer}/authorize`,
        tokenEndpoint: `${issuer}/token`,
        jwksUri: `${issuer}/jwks`,
        clientId,
        callbackLandingPath: '/workspaces',
        redirectUri: 'https://api.integration.test/v1/auth/oidc/callback',
        scopes: ['openid', 'profile', 'email'],
        allowedAlgorithms: ['RS256'],
        timeoutMillis: 5_000,
        transactionTtlMillis: 30_000,
        allowInsecureHttpForTests: false,
      },
      secretEncryption: {
        current: { version: 'integration-v1', key: encryptionKey },
        previous: [],
      },
      session: {
        ttlMillis: 120_000,
        secureCookie: true,
        sameSite: 'lax',
      },
    },
    nodeCompatibilityCohort: 'core',
    nodeEnv: 'test',
    observability: {
      environment: 'test',
      logLevel: 'silent',
      otlpHeaders: {},
      serviceName: 'pertexo-api',
      serviceVersion: 'phase1-integration',
    },
    port: 3000,
    redisUrl,
  };
}

function sessionCookies(header: string | string[] | undefined): SessionCookies {
  const values = Array.isArray(header) ? header : [header ?? ''];
  const flattened = values.flatMap((value) => value.split(/,(?=[^;]+?=)/u));
  const session = cookieValue(flattened, 'pertexo_session');
  const csrf = cookieValue(flattened, 'pertexo_csrf');
  return {
    rawSession: session,
    csrf,
    cookieHeader: `pertexo_session=${session}; pertexo_csrf=${csrf}`,
  };
}

function cookieValue(values: readonly string[], name: string): string {
  const prefix = `${name}=`;
  for (const value of values) {
    const pair = value.split(';', 1)[0]?.trim();
    if (pair?.startsWith(prefix))
      return decodeURIComponent(pair.slice(prefix.length));
  }
  throw new Error(`${name} cookie was not returned`);
}

function mutationHeaders(
  cookies: SessionCookies,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    cookie: cookies.cookieHeader,
    'idempotency-key': `command-${randomUUID()}`,
    'x-csrf-token': cookies.csrf,
    ...extra,
  };
}

function emptyWorkflowGraph() {
  return {
    schemaVersion: 1,
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      {
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'terminate',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {
          result: { kind: 'node_output', nodeId: 'manual', path: '$' },
        },
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'manual-terminate',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'terminate', port: 'in' },
      },
    ],
  } as const;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMillis: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('integration operation timed out'));
    }, timeoutMillis);
    timeout.unref();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(
          error instanceof Error ? error : new Error('integration failed'),
        );
      },
    );
  });
}

function openHttpEventStream(
  port: number,
  path: string,
  cookie: string,
  lastEventId: number,
): Readonly<{
  request: ClientRequest;
  started: Promise<void>;
  closed: Promise<void>;
}> {
  const started = Promise.withResolvers<undefined>();
  const closed = Promise.withResolvers<undefined>();
  let response: IncomingMessage | undefined;
  const request = httpRequest({
    host: '127.0.0.1',
    port,
    path,
    headers: {
      accept: 'text/event-stream',
      cookie,
      'last-event-id': String(lastEventId),
    },
  });
  request.once('error', (error) => {
    if (response === undefined) started.reject(error);
    closed.resolve(undefined);
  });
  request.once('response', (incoming) => {
    response = incoming;
    if (incoming.statusCode !== 200) {
      started.reject(
        new Error(
          `SSE request failed before opening: ${String(incoming.statusCode)}`,
        ),
      );
    } else {
      started.resolve(undefined);
    }
    const resolveClosed = (): void => {
      closed.resolve(undefined);
    };
    incoming.once('aborted', resolveClosed);
    incoming.once('close', resolveClosed);
    incoming.once('end', resolveClosed);
    incoming.once('error', resolveClosed);
    incoming.resume();
  });
  request.end();
  return { request, started: started.promise, closed: closed.promise };
}

function expectProblem(
  response: Readonly<{
    statusCode: number;
    payload: string;
    headers: Readonly<Record<string, unknown>>;
    json(): unknown;
  }>,
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(String(response.headers['content-type'])).toContain(
    'application/problem+json',
  );
  const problem = response.json() as Readonly<Record<string, unknown>>;
  expect(problem).toMatchObject({
    type: `urn:pertexo:problem:${code}`,
    status,
    code,
  });
  expect(problem.title).toEqual(expect.stringMatching(/^\S/u));
  expect(problem.requestId).toEqual(expect.stringMatching(/^\S/u));
}
