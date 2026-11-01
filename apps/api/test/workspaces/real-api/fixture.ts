import { captureLocalAuthenticationMail } from '../../support/better-auth/mail-capture.js';
import { randomUUID } from 'node:crypto';

import {
  auditEvents,
  createWorkspaceDatabase,
  workspaceMemberships,
  workspaces,
  type WorkspaceDatabase,
} from '@pertexo/database/testing';
import {
  createIdentityWorkspaceDatabase,
  type IdentityWorkspaceDatabase,
} from '@pertexo/core/testing';

import { afterAll, beforeAll, expect } from 'vitest';
import { createTestApiApplication } from '../../support/api-application.js';
import {
  SESSION_AUTHORITY,
  type IdentitySessionAuthority,
} from '../../../src/workspaces/index.js';

import { createApiIdentityRuntime } from '../../../src/platform/identity/runtime.module.js';

import {
  FixtureResourceOwner,
  rethrowFixtureSetupFailure,
} from '../../browser/harness/resource-owner.js';
import {
  publicOrigin,
  password,
  databaseConfig,
  logger,
  telemetry,
} from './environment.js';
import type { SessionCookies } from './contract.js';
import { config } from './configuration.js';
import { sessionCookies, rawCookieValue, mutationHeaders } from './cookies.js';
import { emptyWorkflowGraph } from './graphs.js';
import { expectProblem } from './assertions.js';
import { archiveWorkflow, withOwnerWorkspace } from './queries.js';

export function createWorkspaceApiFixture() {
  const { mail, mailedMessages } = captureLocalAuthenticationMail();

  const ownerEmail = `${randomUUID()}@example.test`;

  let application: Awaited<ReturnType<typeof createTestApiApplication>>;

  let identityDatabase: IdentityWorkspaceDatabase;

  let workspaceDatabase: WorkspaceDatabase;

  let resources: FixtureResourceOwner | undefined;

  let requestAddress = 0;

  beforeAll(async () => {
    const owner = new FixtureResourceOwner();
    resources = owner;
    try {
      identityDatabase = owner.acquire(
        'identity database',
        createIdentityWorkspaceDatabase(databaseConfig),
        (database) => database.close(),
      );
      workspaceDatabase = owner.acquire(
        'workspace database',
        createWorkspaceDatabase(databaseConfig),
        (database) => database.close(),
      );
      const identityConfig = config().identity;
      if (identityConfig === undefined)
        throw new Error('Identity integration configuration is missing');
      const identityRuntime = owner.acquire(
        'identity runtime',
        await createApiIdentityRuntime(identityConfig, databaseConfig, {
          authenticationMail: mail,
        }),
        (runtime) => runtime.close(),
      );
      const borrowedIdentityRuntime = Object.freeze({
        ...identityRuntime,
        close: () => Promise.resolve(),
      });
      application = owner.acquire(
        'API application',
        await createTestApiApplication(config(), {
          database: workspaceDatabase,
          identityRuntime: borrowedIdentityRuntime,
          logger,
          telemetry,
        }),
        (app) => app.close(),
      );
      await application.init();
      await signUp(ownerEmail, 'Phase One Real Stack');
    } catch (error: unknown) {
      await rethrowFixtureSetupFailure(owner, error);
    }
  });

  afterAll(async () => {
    await resources?.close();
  });

  function send(
    url: string,
    payload: object,
  ): ReturnType<typeof application.inject> {
    requestAddress += 1;
    return application.inject({
      method: 'POST',
      url,
      remoteAddress: `198.51.100.${String(30 + (requestAddress % 200))}`,
      headers: { origin: publicOrigin },
      payload,
    });
  }

  /** Signs up and follows the mailed verification link. */
  async function signUp(email: string, name: string): Promise<void> {
    const created = await send('/v1/auth/sign-up/email', {
      name,
      email,
      password,
      callbackURL: '/login?verified=true',
    });
    expect(created.statusCode, created.payload).toBe(200);
    const message = mailedMessages(email)
      .filter((item) => item.purpose === 'verification')
      .at(-1);
    if (message === undefined) throw new Error('No verification mail');
    const link = new URL(message.url);
    const verified = await application.inject({
      method: 'GET',
      url: link.pathname + link.search,
    });
    expect(verified.statusCode).toBe(302);
  }

  async function signIn(email: string): Promise<SessionCookies> {
    const signedIn = await send('/v1/auth/sign-in/email', {
      email,
      password,
      callbackURL: '/workspaces',
    });
    expect(signedIn.statusCode, signedIn.payload).toBe(200);
    return sessionCookies(signedIn.headers['set-cookie']);
  }

  function login(): Promise<SessionCookies> {
    return signIn(ownerEmail);
  }

  /** A server-issued session for a user who never signs in through HTTP. */
  async function issueSession(userId: string): Promise<SessionCookies> {
    const setCookies: string[] = [];
    await application.get<IdentitySessionAuthority>(SESSION_AUTHORITY).issue(
      { userId },
      {
        writeSessionCookieHeaders: (values) => {
          setCookies.push(...values);
        },
      },
    );
    const session = rawCookieValue(setCookies, 'pertexo_session');
    return {
      rawSession: session,
      csrf: '',
      cookieHeader: `pertexo_session=${session}`,
    };
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
      /^"draft\.[A-Za-z0-9_-]{43}"$/u,
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
    expect(firstTag).toMatch(/^"draft\.[A-Za-z0-9_-]{43}"$/u);

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
  return {
    login,
    createPublishedWorkflow,
    get application() {
      return application;
    },
    withOwnerWorkspace,
    archiveWorkflow,
    get workspaceDatabase() {
      return workspaceDatabase;
    },
    workspaceAggregate,
    createWorkspace,
    ownerEmail,
    get identityDatabase() {
      return identityDatabase;
    },
    issueSession,
    authenticatedMutation,
    signUp,
    signIn,
  };
}
