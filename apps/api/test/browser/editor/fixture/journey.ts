import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { createServer } from 'node:http';

import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, it } from 'vitest';

import {
  workspaceResponseSchema,
  workflowCreateResponseSchema,
} from '@pertexo/contracts';

import { prepareWorkflowPortabilityBrowserFixture } from '../portability.fixture.js';

import { prepareCuratedTemplateBrowserFixture } from '../../curated-templates/fixture.js';

import {
  scenario,
  webOrigin,
  webDirectory,
  webRequire,
  editorJourneyPath,
} from './environment.js';
import { fixtureState } from './state.js';
import {
  owner,
  browserChildren,
  ownChild,
  recheckOwnership,
} from './lifecycle.js';
import type { createEditorBrowserFixture } from './setup.js';
import type {
  EditorBrowserApi,
  EditorBrowserJourneyContext,
} from './contract.js';
import { createEditorControlServer } from '../control/server.js';
import { verifyEditorBrowserOutcome } from '../outcomes/dispatch.js';
import { liveWebPort } from '../../web-origin.js';

export function registerEditorBrowserJourney(
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
    PERTEXO_LIVE_WEB_ORIGIN: webOrigin,
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
    String(liveWebPort),
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
