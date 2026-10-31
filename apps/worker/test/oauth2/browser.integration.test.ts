import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PASSWORD } from '../support/recovery/api.js';
import {
  startOAuth2Harness,
  useOAuth2Timeouts,
  type OAuth2Harness,
} from '../support/oauth2/harness.js';

useOAuth2Timeouts();

const enabled = process.env.OAUTH2_BROWSER_INTEGRATION === 'true';
const JOURNEY_LIMIT_MS = 900_000;
const webDirectory = new URL('../../../web/', import.meta.url);
const webRequire = createRequire(new URL('package.json', webDirectory));
const webPort = Number(process.env.PERTEXO_LIVE_WEB_PORT ?? '4176');
// A name, because S15 refuses the web host and the stand-in is on 127.0.0.1.
const webOrigin = `http://localhost:${String(webPort)}`;

describe.skipIf(!enabled)('OAuth2 connections in a real browser', () => {
  let harness: OAuth2Harness;
  const children: ChildProcess[] = [];

  const start = (
    arguments_: readonly string[],
    environment: NodeJS.ProcessEnv,
  ): ChildProcess => {
    const child = spawn(process.execPath, [...arguments_], {
      cwd: webDirectory,
      env: environment,
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
    });
    children.push(child);
    return child;
  };

  const finished = (child: ChildProcess): Promise<number | null> =>
    new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });

  beforeAll(async () => {
    harness = await startOAuth2Harness('browser', { webOrigin });
  });

  afterAll(async () => {
    for (const child of children)
      if (child.pid !== undefined && child.exitCode === null)
        process.kill(-child.pid, 'SIGKILL');
    await harness.close();
  });

  it(
    'runs the journey through real consent and back into HTTP Request',
    async () => {
      const owner = await harness.newOwner();
      const viewer = await harness.addMember(owner.workspaceId, 'viewer');
      const builder = await harness.addMember(owner.workspaceId, 'builder');
      const environment = {
        ...process.env,
        PERTEXO_API_PROXY_TARGET: harness.stack.baseUrl,
        PERTEXO_LIVE_WEB_ORIGIN: webOrigin,
        PERTEXO_OAUTH2_JOURNEY: JSON.stringify({
          standIn: harness.standIn.origin,
          password: PASSWORD,
          workspaceId: owner.workspaceId,
          owner: owner.email,
          viewer: viewer.email,
          builder: builder.email,
        }),
      };
      const vite = join(
        dirname(webRequire.resolve('vite/package.json')),
        'bin/vite.js',
      );
      const production = { ...environment, NODE_ENV: 'production' };
      expect(await finished(start([vite, 'build'], production))).toBe(0);
      const preview = start(
        [
          vite,
          'preview',
          '--host',
          '127.0.0.1',
          '--port',
          String(webPort),
          '--strictPort',
        ],
        production,
      );
      const deadline = Date.now() + 15_000;
      for (;;) {
        if (preview.exitCode !== null)
          throw new Error('The web preview exited during startup');
        const up = await fetch(`http://127.0.0.1:${String(webPort)}`).catch(
          () => undefined,
        );
        if (up?.ok === true) break;
        if (Date.now() > deadline) throw new Error('The web preview is down');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const playwright = start(
        [
          webRequire.resolve('@playwright/test/cli'),
          'test',
          '--config',
          'playwright.live.config.ts',
          'oauth2-connections.spec.ts',
          // One scene, for proving a guard without the whole journey.
          ...(process.env.OAUTH2_JOURNEY_GREP === undefined
            ? []
            : ['--grep', process.env.OAUTH2_JOURNEY_GREP]),
        ],
        environment,
      );
      expect(await finished(playwright)).toBe(0);
    },
    JOURNEY_LIMIT_MS,
  );
});
