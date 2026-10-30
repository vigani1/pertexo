import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  registerAccount,
  signIn,
  createWorkspace,
  publishWorkflow,
  graphOf,
  openSecretUrlEndpoint,
  type Browser,
} from '../../security/actions.js';
import type * as StackModule from '../../security/stack.js';
import type { Stack } from '../../security/stack.js';

const enabled = process.env.SECURITY_BROWSER_INTEGRATION === 'true';
const execute = promisify(execFile);
const webDirectory = fileURLToPath(
  new URL('../../../../web/', import.meta.url),
);
const webRequire = createRequire(join(webDirectory, 'package.json'));
const JOURNEY_TIMEOUT = 300_000;

/** A child that exits 0 or fails the test with its output. */
function run(args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, args, {
      cwd: webDirectory,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${args.join(' ')} exited ${String(code)}`));
    });
  });
}

function playwright(spec: string, environment: NodeJS.ProcessEnv) {
  return run(
    [
      webRequire.resolve('@playwright/test/cli'),
      'test',
      '--config',
      'playwright.live.config.ts',
      spec,
    ],
    environment,
  );
}

/** What the journeys ask of their control listener: mail, and the browser's lifetime. */
async function controlServer(stack: () => Stack): Promise<{
  origin: string;
  server: Server;
}> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://control');
    if (url.pathname === '/verification') {
      const email = url.searchParams.get('email') ?? '';
      const heading = `verification for ${email}\n`;
      const logs = stack().api.logs;
      const at = logs.lastIndexOf(heading);
      if (at < 0) {
        response.writeHead(404).end();
        return;
      }
      const link = new URL(
        logs.slice(at + heading.length).split('\n')[0] ?? '',
      );
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ path: link.pathname + link.search }));
      return;
    }
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Control listener has no port');
  return { origin: `http://127.0.0.1:${String(address.port)}`, server };
}

async function pinnedWebImage(): Promise<string> {
  const dockerfile = await readFile(
    new URL('../../../../../Dockerfile', import.meta.url),
    'utf8',
  );
  const image = /^FROM (\S+) AS web$/mu.exec(dockerfile)?.[1];
  if (image === undefined) throw new Error('Dockerfile names no web image');
  return image;
}

describe.runIf(enabled)('the real web app in a real browser', () => {
  let startStack: typeof StackModule.startStack;
  beforeAll(async () => {
    ({ startStack } = await import('../../security/stack.js'));
  });

  describe('behind the production nginx config', () => {
    const container = `pertexo-security-${randomUUID()}`;
    let stack: Stack;
    let control: Awaited<ReturnType<typeof controlServer>>;
    let webOrigin: string;

    beforeAll(async () => {
      control = await controlServer(() => stack);
      const viteCli = join(
        dirname(webRequire.resolve('vite/package.json')),
        'bin/vite.js',
      );
      await run([viteCli, 'build'], { NODE_ENV: 'production' });
      const apiPort = 20_000 + Math.floor(Math.random() * 20_000);
      await execute('docker', [
        'run',
        '--detach',
        '--rm',
        '--name',
        container,
        '--add-host=host.docker.internal:host-gateway',
        '--publish',
        '127.0.0.1::8080',
        '--env',
        `PERTEXO_API_UPSTREAM=http://host.docker.internal:${String(apiPort)}`,
        '--env',
        'NGINX_ENVSUBST_FILTER=^PERTEXO_API_UPSTREAM$',
        '--mount',
        `type=bind,src=${join(webDirectory, 'dist')},dst=/usr/share/nginx/html,readonly`,
        '--mount',
        `type=bind,src=${join(webDirectory, 'deployment/nginx.conf.template')},dst=/etc/nginx/templates/default.conf.template,readonly`,
        await pinnedWebImage(),
      ]);
      const { stdout } = await execute('docker', [
        'port',
        container,
        '8080/tcp',
      ]);
      webOrigin = `http://${stdout.trim().split('\n')[0] ?? ''}`;
      stack = await startStack({
        port: apiPort,
        host: '0.0.0.0',
        webOrigin,
        worker: true,
      });
      for (let waited = 0; waited < 30_000; waited += 250) {
        const ready = await fetch(webOrigin).catch(() => undefined);
        await ready?.arrayBuffer();
        if (ready?.ok === true) return;
        await delay(250);
      }
      throw new Error('nginx never served the app');
    }, JOURNEY_TIMEOUT);

    afterAll(async () => {
      await execute('docker', ['rm', '--force', container]).catch(
        () => undefined,
      );
      control.server.close();
      await stack.close();
    }, 60_000);

    it(
      'signs up, signs in and edits under the policy',
      async () => {
        await expect(
          playwright('security/app-under-policy.spec.ts', {
            PERTEXO_LIVE_WEB_ORIGIN: webOrigin,
            PERTEXO_LIVE_MAIL_ORIGIN: control.origin,
          }),
        ).resolves.toBeUndefined();
      },
      JOURNEY_TIMEOUT,
    );
  });

  describe('with webhook responses on the app origin', () => {
    const STEAL = `fetch('/v1/users/me').then(function(r){return r.text()}).then(function(t){document.title='PWNED';return fetch('/v1/stolen?who='+encodeURIComponent(t))})`;
    const XHTML = `<html xmlns="http://www.w3.org/1999/xhtml"><body><script>//<![CDATA[
${STEAL}
//]]></script></body></html>`;
    const SVG = `<svg xmlns="http://www.w3.org/2000/svg"><script>//<![CDATA[
${STEAL}
//]]></script></svg>`;
    const STYLESHEET = `<?xml-stylesheet type="text/xsl" href="#s"?><!DOCTYPE d [<!ATTLIST xsl:stylesheet id ID #REQUIRED>]><d><xsl:stylesheet id="s" version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template match="/"><html xmlns="http://www.w3.org/1999/xhtml"><script>${STEAL}</script></html></xsl:template></xsl:stylesheet></d>`;
    const HTML = `<!doctype html><html><script>${STEAL}</script></html>`;

    let stack: Stack;
    let control: Awaited<ReturnType<typeof controlServer>>;
    const hooks: Record<string, string> = {};

    async function publishResponder({
      browser,
      workspaceId,
      name,
      config,
      body,
    }: Readonly<{
      browser: Browser;
      workspaceId: string;
      name: string;
      config: unknown;
      body: unknown;
    }>) {
      let published;
      try {
        published = await publishWorkflow(
          stack,
          browser,
          workspaceId,
          graphOf([
            {
              id: 'hook',
              key: 'core.webhook',
              config: { responseMode: 'workflow', responseWaitSeconds: 10 },
            },
            {
              id: 'answer',
              key: 'core.respond_webhook',
              config,
              inputMappings: {
                body: { kind: 'literal', value: body },
              },
            },
          ]),
        );
      } catch (error: unknown) {
        // Refusing XML at authoring time is one of the two right answers;
        // anything else failing here must not pass as "no link to open".
        if (
          name.startsWith('xml-') &&
          error instanceof Error &&
          error.message.includes('textContentType')
        )
          return;
        throw error;
      }
      const path = await openSecretUrlEndpoint(stack, browser, published.path);
      // A false pass must not hide here: the link really does answer with the body.
      const answer = await stack.send('GET', path, { withoutOrigin: true });
      expect(answer.status, `${name}: ${answer.text}`).not.toBe(202);
      expect(answer.status, `${name}: ${answer.text}`).toBeLessThan(400);
      hooks[name] = path;
    }

    beforeAll(async () => {
      control = await controlServer(() => stack);
      stack = await startStack({
        worker: true,
        environment: { AUTH_SIGN_UP_MODE: 'open' },
      });
      await registerAccount(stack, 'attacker@integration.test');
      await registerAccount(stack, 'victim@integration.test');
      const browser = await signIn(stack, 'attacker@integration.test');
      const workspaceId = await createWorkspace(stack, browser);
      const text = (type: string) => ({
        bodyType: 'text',
        textContentType: type,
      });
      for (const [name, config, body] of [
        ['xml-xhtml', text('application/xml'), XHTML],
        ['xml-svg', text('application/xml'), SVG],
        ['xml-stylesheet', text('application/xml'), STYLESHEET],
        ['plain-html', text('text/plain'), HTML],
        ['csv-html', text('text/csv'), HTML],
        ['json-html', { bodyType: 'json' }, { page: HTML }],
      ] as const)
        await publishResponder({ browser, workspaceId, name, config, body });
    }, JOURNEY_TIMEOUT);

    afterAll(async () => {
      control.server.close();
      await stack.close();
    }, 60_000);

    it(
      'never runs script from a response',
      async () => {
        await expect(
          playwright('security/webhook-response.spec.ts', {
            PERTEXO_LIVE_WEB_ORIGIN: stack.apiOrigin,
            PERTEXO_LIVE_MAIL_ORIGIN: control.origin,
            PERTEXO_SECURITY_HOOKS: JSON.stringify(hooks),
            PERTEXO_SECURITY_VICTIM: 'victim@integration.test',
          }),
        ).resolves.toBeUndefined();
      },
      JOURNEY_TIMEOUT,
    );
  });
});
