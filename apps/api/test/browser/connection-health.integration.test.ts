import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { FixtureResourceOwner } from './harness/resource-owner.js';
import { ownEditorBrowserProcess } from './harness/process.js';
import { useConnectionHealthFixture } from '../connections/health/fixture.js';

const enabled = process.env.CONNECTION_HEALTH_BROWSER_INTEGRATION === 'true';
const webOrigin = 'http://127.0.0.1:4174';
const webDirectory = new URL('../../../web/', import.meta.url);
const webRequire = createRequire(new URL('package.json', webDirectory));
function successfulExit(
  child: ChildProcess,
  diagnostic: () => string = () => '',
) {
  return new Promise<void>((resolve, reject) => {
    child.once('error', () => {
      reject(new Error('Owned health browser startup failed'));
    });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Owned health browser exited ${String(code)} ${diagnostic()}`,
          ),
        );
    });
  });
}

describe.skipIf(!enabled)(
  'real connection health API, worker and browser',
  () => {
    const owner = new FixtureResourceOwner(),
      open = new Set<string>();
    const lifetimes: ReturnType<typeof ownEditorBrowserProcess>[] = [];
    let opened = false;
    const fixture = useConnectionHealthFixture('connection_health_browser', {
      webOrigin,
      browserLifetime: (path, id) => {
        if (path === '/browser-opened') {
          opened = true;
          open.add(id);
        } else if (!open.delete(id))
          throw new Error('Unknown owned health browser');
      },
      beforeClose: async () => {
        for (const lifetime of lifetimes.toReversed()) await lifetime.close();
        await owner.close();
      },
    });
    it('recovers durable Slack rejection after worker restart, fences old responses across Test and Rotate, and denies revoked readers', async () => {
      const seeded = await fixture.seed();
      let output = '';
      const diagnostic = () => {
        let safe = output;
        for (const secret of [
          seeded.browser.session,
          seeded.browser.csrf,
          encodeURIComponent(seeded.browser.csrf),
          'xoxb-owned-fixture-token-1',
          'xoxb-owned-fixture-token-2',
        ])
          safe = safe.split(secret).join('[redacted]');
        return safe.slice(-10000);
      };
      const environment = {
        ...process.env,
        PERTEXO_API_PROXY_TARGET: await fixture.api.listen(),
        PERTEXO_LIVE_MAIL_ORIGIN: fixture.controlOrigin,
      };
      const start = (args: string[], kind: 'vite' | 'browser') => {
        const child = spawn(process.execPath, args, {
          cwd: webDirectory,
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        for (const stream of [child.stdout, child.stderr])
          stream.on('data', (chunk: Buffer) => {
            if (output.length < 131072) output += chunk.toString();
            else output = 'Owned browser diagnostic exceeded bound';
          });
        const lifetime = ownEditorBrowserProcess(child, kind, {
          browserDisposed: () => opened && open.size === 0,
        });
        lifetimes.push(lifetime);
        return owner.acquire(kind, child, () => lifetime.close());
      };
      const vite = join(
        dirname(webRequire.resolve('vite/package.json')),
        'bin/vite.js',
      );
      await successfulExit(start([vite, 'build'], 'vite'));
      const preview = start(
        [
          vite,
          'preview',
          '--host',
          '127.0.0.1',
          '--port',
          '4174',
          '--strictPort',
        ],
        'vite',
      );
      const deadline = Date.now() + 15000;
      for (;;) {
        if (preview.exitCode !== null || preview.signalCode !== null)
          throw new Error('Owned health preview exited');
        try {
          if (
            (await fetch(webOrigin, { signal: AbortSignal.timeout(1000) })).ok
          )
            break;
        } catch {
          /* Only owned startup is retried. */
        }
        if (Date.now() > deadline)
          throw new Error('Owned health preview startup deadline');
        await delay(50);
      }
      output = '';
      await successfulExit(
        start(
          [
            webRequire.resolve('@playwright/test/cli'),
            'test',
            '--config',
            'playwright.live.config.ts',
            'connection-health.spec.ts',
          ],
          'browser',
        ),
        diagnostic,
      );
      expect(opened).toBe(true);
      expect(open.size).toBe(0);
      expect(fixture.providerCalls).toBe(4);
    }, 150000);
  },
);
