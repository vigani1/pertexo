import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { describe, vi } from 'vitest';

import {
  startOAuth2StandIn,
  type OAuth2StandIn,
} from '../../../../../infrastructure/testing/oauth2-stand-in.mjs';
import { waitForRunsToEnd, type RunFacts } from '../recovery/facts.js';
import {
  startStack,
  type Stack,
  type StackOptions,
} from '../recovery/stack.js';

import { OAuth2Browser, type BrowserResponse } from './browser.js';
import { httpStepGraph, type OAuth2Step } from './graphs.js';
import {
  consentSettings,
  serverSettings,
  type SettingsOverrides,
} from './settings.js';
import { storedFacts } from './stored.js';

/** A real stack with Postgres and Redis: what the worker's integration job has. */
export const describeOAuth2 =
  process.env.WORKER_TRANSPORT_INTEGRATION === 'true'
    ? describe
    : describe.skip;

const STACK_LIMIT_MS = 240_000;
const SCENARIO_MS = 120_000;
/** Runs end quickly here; only a step's own retries take seconds. */
const RUN_LIMIT_MS = 90_000;

/** Stack startup and one whole scenario, far past the integration defaults. */
export function useOAuth2Timeouts(): void {
  vi.setConfig({ testTimeout: SCENARIO_MS, hookTimeout: STACK_LIMIT_MS });
}

/**
 * S15 always refuses the host of PUBLIC_WEB_ORIGIN, and the stand-in is on
 * 127.0.0.1, so the install's public name has to be something else.
 */
export const WEB_ORIGIN = 'http://localhost:5999';
export const CALLBACK_PATH = '/v1/connections/oauth2/callback';
export const REDIRECT_URI = `${WEB_ORIGIN}${CALLBACK_PATH}`;
export const LANDING_PATH = '/connections/oauth2/finished';
const ALLOWED_NETWORKS = '127.0.0.1/32';

/** Names the test resolves itself; see names-preload.mjs. */
const TEST_HOSTS = Object.freeze({
  // Real connections to the stand-in, through a name.
  'listed.example.test': { address: '127.0.0.1', via: 'dial' },
  'api.listed.example.test': { address: '127.0.0.1', via: 'dial' },
  'other.example.test': { address: '127.0.0.1', via: 'dial' },
  // A public address answering over HTTPS, as a connection test requires.
  'api.public.example.test': { address: '8.8.8.8', via: 'route' },
  // Must never be reached: anything sent here shows up under /leak.
  'private.example.test': { address: '10.0.0.5', via: 'leak' },
  'metadata.example.test': { address: '169.254.169.254', via: 'leak' },
  'public.example.test': { address: '8.8.8.8', via: 'leak' },
});

export type Owner = Readonly<{
  api: OAuth2Browser;
  email: string;
  workspaceId: string;
}>;
type Role = 'admin' | 'builder' | 'operator' | 'viewer';

type AddedMember = Readonly<{
  api: OAuth2Browser;
  email: string;
  userId: string;
}>;

export type Connection = Readonly<{
  id: string;
  clientId: string;
  clientSecret: string;
  secretVersionId: string;
  body: Record<string, unknown>;
}>;

type Landing = Readonly<{
  status: number;
  result: string | null;
  workspaceId: string | null;
  connectionId: string | null;
  headers: Headers;
  location: string | null;
}>;

export type OAuth2Harness = ReturnType<typeof storedFacts> &
  Readonly<{
    stack: Stack;
    standIn: OAuth2StandIn;
    close: () => Promise<void>;
    newOwner: () => Promise<Owner>;
    addMember: (workspaceId: string, role: Role) => Promise<AddedMember>;
    /** A browser of nobody: no cookies, its own client address. */
    anonymousBrowser: () => OAuth2Browser;
    settings: (clientId: string, overrides?: SettingsOverrides) => unknown;
    serverSettings: (
      clientId: string,
      overrides?: SettingsOverrides,
    ) => unknown;
    createResponse: (
      owner: Owner,
      settings: unknown,
      clientSecret?: string,
    ) => Promise<BrowserResponse>;
    create: (
      owner: Owner,
      behavior: string,
      overrides?: SettingsOverrides,
    ) => Promise<Connection>;
    createServer: (
      owner: Owner,
      behavior: string,
      overrides?: SettingsOverrides,
    ) => Promise<Connection>;
    start: (
      api: OAuth2Browser,
      owner: Owner,
      connectionId: string,
    ) => Promise<BrowserResponse>;
    authorizationUrl: (response: BrowserResponse) => string;
    decide: (authorizationUrl: string, decision: string) => Promise<string>;
    land: (
      api: OAuth2Browser,
      callbackUrl: string,
      sendCookie?: (name: string) => boolean,
      signal?: AbortSignal,
    ) => Promise<Landing>;
    /** Create, consent and approve: an active connection with real tokens. */
    connected: (
      owner: Owner,
      behavior: string,
      overrides?: SettingsOverrides,
    ) => Promise<Connection>;
    reconnect: (owner: Owner, connection: Connection) => Promise<Landing>;
    read: (
      api: OAuth2Browser,
      owner: Owner,
      connectionId: string,
    ) => Promise<BrowserResponse>;
    run: (owner: Owner, step: OAuth2Step) => Promise<string>;
    finish: (runId: string) => Promise<RunFacts>;
    test: (
      owner: Owner,
      connectionId: string,
      url: string,
    ) => Promise<BrowserResponse>;
    apiUrl: (path?: string) => string;
  }>;

const preload = fileURLToPath(new URL('./names-preload.mjs', import.meta.url));

const clientAddress = (): string =>
  `10.${String(randomInt(0, 256))}.${String(randomInt(0, 256))}.${String(randomInt(1, 255))}`;

const isBindingCookie = (name: string): boolean =>
  name.startsWith('pertexo_oauth2_');

export async function startOAuth2Harness(
  name: string,
  options: StackOptions = {},
): Promise<OAuth2Harness> {
  const standIn = await startOAuth2StandIn();
  const webOrigin = options.webOrigin ?? WEB_ORIGIN;
  const stack = await startStack(`oauth2-${name}`, {
    ...options,
    webOrigin,
    environment: {
      // A workspace here has many people, each signing up on their own.
      AUTH_SIGN_UP_MODE: 'open',
      HTTP_ALLOWED_PRIVATE_NETWORKS: ALLOWED_NETWORKS,
      NODE_OPTIONS: `--import=${preload}`,
      OAUTH2_TEST_HOSTS: JSON.stringify(TEST_HOSTS),
      OAUTH2_TEST_SINK: standIn.origin,
      TRUST_PROXY_CIDRS: '127.0.0.1/32',
      ...options.environment,
    },
  });

  const newBrowser = (): OAuth2Browser =>
    new OAuth2Browser(stack.baseUrl, webOrigin, clientAddress());

  const signedIn = async (): Promise<AddedMember> => {
    const api = newBrowser();
    const email = `oauth2-${randomUUID().slice(0, 8)}@example.test`;
    await api.signUp(email);
    const [user] = await stack.sql<{ id: string }>(
      `update app.users set email_verified=true where email=$1 returning id`,
      [email],
    );
    await api.signIn(email);
    return { api, email, userId: user?.id ?? '' };
  };

  const settings = (clientId: string, overrides?: SettingsOverrides) =>
    consentSettings(standIn.origin, clientId, overrides);
  const server = (clientId: string, overrides?: SettingsOverrides) =>
    serverSettings(standIn.origin, clientId, overrides);

  const createResponse = (
    owner: Owner,
    body: unknown,
    clientSecret = 'not-a-secret-of-this-test',
  ): Promise<BrowserResponse> =>
    owner.api.call(
      'POST',
      `/v1/workspaces/${owner.workspaceId}/connections`,
      {
        providerKey: 'http',
        name: `OAuth2 ${randomUUID().slice(0, 8)}`,
        credential: { type: 'oauth2', settings: body, clientSecret },
      },
      { 'idempotency-key': randomUUID() },
    );

  const createWith = async (
    owner: Owner,
    behavior: string,
    build: (clientId: string, overrides?: SettingsOverrides) => unknown,
    overrides: SettingsOverrides = {},
  ): Promise<Connection> => {
    const clientId = standIn.newClient(behavior);
    const clientSecret = `client-secret-${randomUUID()}`;
    standIn.expectSecret(clientId, clientSecret);
    const response = await createResponse(
      owner,
      build(clientId, overrides),
      clientSecret,
    );
    if (response.status !== 201)
      throw new Error(
        `Create answered ${String(response.status)}: ${JSON.stringify(response.json).slice(0, 300)}`,
      );
    const body = response.json as { id: string; secretVersionId: string };
    return {
      id: body.id,
      clientId,
      clientSecret,
      secretVersionId: body.secretVersionId,
      body: response.json as Record<string, unknown>,
    };
  };

  const start = (api: OAuth2Browser, owner: Owner, connectionId: string) =>
    api.call(
      'POST',
      `/v1/workspaces/${owner.workspaceId}/connections/${connectionId}/oauth2/authorization`,
    );

  const authorizationUrl = (response: BrowserResponse): string => {
    const body = response.json as { authorizationUrl?: string };
    if (response.status !== 200 || body.authorizationUrl === undefined)
      throw new Error(
        `Start answered ${String(response.status)}: ${JSON.stringify(response.json).slice(0, 300)}`,
      );
    return body.authorizationUrl;
  };

  /** The person's browser at the service: it answers with where to go back to. */
  const decide = async (url: string, decision: string): Promise<string> => {
    const consent = new URL(url);
    const page = await fetch(consent);
    if (page.status !== 200)
      throw new Error(`Consent page answered ${String(page.status)}`);
    const decided = await fetch(`${standIn.origin}/authorize/decide`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...Object.fromEntries(consent.searchParams),
        decision,
      }).toString(),
    });
    const location = decided.headers.get('location');
    if (location === null) throw new Error('The service sent nothing back');
    return location;
  };

  const land = async (
    api: OAuth2Browser,
    callbackUrl: string,
    sendCookie: (name: string) => boolean = isBindingCookie,
    signal?: AbortSignal,
  ): Promise<Landing> => {
    const url = new URL(callbackUrl);
    const answer = await api.navigate(
      `${url.pathname}${url.search}`,
      sendCookie,
      signal,
    );
    const landing =
      answer.location === null
        ? undefined
        : new URL(answer.location, webOrigin);
    return {
      status: answer.status,
      headers: answer.headers,
      location: answer.location,
      result: landing?.searchParams.get('result') ?? null,
      workspaceId: landing?.searchParams.get('workspaceId') ?? null,
      connectionId: landing?.searchParams.get('connectionId') ?? null,
    };
  };

  const consentOn = async (owner: Owner, connectionId: string) => {
    const url = authorizationUrl(await start(owner.api, owner, connectionId));
    return land(owner.api, await decide(url, 'approve'));
  };

  const harness: OAuth2Harness = Object.freeze({
    ...storedFacts(stack),
    stack,
    standIn,
    async close() {
      await stack.close();
      await standIn.close();
    },
    async newOwner() {
      const { api, email } = await signedIn();
      return {
        api,
        email,
        workspaceId: await api.createWorkspace(
          `oauth2-${randomUUID().slice(0, 8)}`,
        ),
      };
    },
    async addMember(workspaceId, role) {
      const member = await signedIn();
      await stack.sql(
        `insert into app.workspace_memberships(workspace_id,user_id,role,status)
         values($1,$2,$3,'active')`,
        [workspaceId, member.userId, role],
      );
      return member;
    },
    anonymousBrowser: newBrowser,
    settings,
    serverSettings: server,
    createResponse,
    create: (owner, behavior, overrides) =>
      createWith(owner, behavior, settings, overrides),
    createServer: (owner, behavior, overrides) =>
      createWith(owner, behavior, server, overrides),
    start,
    authorizationUrl,
    decide,
    land,
    async connected(owner, behavior, overrides) {
      const connection = await createWith(owner, behavior, settings, overrides);
      const landing = await consentOn(owner, connection.id);
      if (landing.result !== 'connected')
        throw new Error(
          `Consent landed on ${String(landing.result)} for ${connection.clientId}`,
        );
      return connection;
    },
    reconnect: (owner, connection) => consentOn(owner, connection.id),
    read: (api, owner, connectionId) =>
      api.call(
        'GET',
        `/v1/workspaces/${owner.workspaceId}/connections/${connectionId}`,
      ),
    async run(owner, step) {
      const workflowId = await owner.api.publish(
        owner.workspaceId,
        `OAuth2 step ${randomUUID().slice(0, 8)}`,
        httpStepGraph(step),
      );
      return owner.api.startRun(owner.workspaceId, workflowId);
    },
    async finish(runId) {
      const facts = await waitForRunsToEnd(stack, [runId], RUN_LIMIT_MS);
      const ended = facts[runId];
      if (ended === undefined) throw new Error(`Run ${runId} is not stored`);
      return ended;
    },
    test: (owner, connectionId, url) =>
      owner.api.call(
        'POST',
        `/v1/workspaces/${owner.workspaceId}/connections/${connectionId}/test`,
        { url },
        { 'idempotency-key': randomUUID() },
      ),
    apiUrl: (path = '/api') => `${standIn.origin}${path}`,
  });
  return harness;
}
