import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { useBetterAuthRealApi } from '../../../support/better-auth/real-api.support.js';
import { FixtureResourceOwner } from '../../harness/resource-owner.js';
import { ownEditorBrowserProcess } from '../../harness/process.js';
import { verifyEditorBrowserOwnership } from '../../harness/ownership.js';
import {
  assertOrganizationPreviewPortVacant,
  closeOrganizationBrowserBarriers,
  waitForOwnedOrganizationPreview,
} from '../../workflow-organization-lifetime.js';
import {
  createBrowserSamlProvider,
  createSamlAppProxy,
} from './saml-provider.js';
import { liveWebOrigin, liveWebPort } from '../../web-origin.js';

const enabled =
  process.env.EDITOR_BROWSER_INTEGRATION === 'true' &&
  process.env.EDITOR_BROWSER_CASE === 'organization-saml';
const appOrigin = `https://127.0.0.1:${String(liveWebPort + 1)}`,
  webOrigin = liveWebOrigin;
const webDirectory = new URL('../../../../../web/', import.meta.url),
  webRequire = createRequire(new URL('package.json', webDirectory));
const lifetime = z.strictObject({ instanceId: z.uuid() });
async function recheckOwnership() {
  await verifyEditorBrowserOwnership(
    process.env,
    async (id) => (await promisify(execFile)('docker', ['inspect', id])).stdout,
  );
}
describe.skipIf(!enabled)(
  'organization SAML in a real cross-site browser',
  () => {
    const owner = new FixtureResourceOwner(),
      barriers: ReturnType<typeof ownEditorBrowserProcess>[] = [],
      pending = new Set<Promise<void>>(),
      openBrowsers = new Set<string>();
    let opened = false;
    beforeAll(async () => {
      await recheckOwnership();
      await assertOrganizationPreviewPortVacant(liveWebPort);
      await assertOrganizationPreviewPortVacant(liveWebPort + 1);
    });
    const api = useBetterAuthRealApi('saml_browser', {
      publicWebOrigin: appOrigin,
      secureCookies: true,
      federationEncryption: {
        current: {
          version: 'saml-browser-v1',
          key: Buffer.alloc(32, 0x51).toString('base64'),
        },
        previous: [],
      },
      beforeClose: async () => {
        await closeOrganizationBrowserBarriers(barriers);
        await Promise.allSettled([...pending]);
        await owner.close();
      },
      beforeDrop: recheckOwnership,
    });
    beforeAll(() => {
      const dns = vi
        .spyOn(Resolver.prototype, 'resolveTxt')
        .mockImplementation(async (hostname) => {
          const rows = await api
            .database()
            .query<{ challenge: string }>(
              'select challenge from app.auth_domains where domain=$1 and challenge is not null',
              [hostname.replace(/^_pertexo\./u, '')],
            );
          return rows.rows.map((row) => [
            `pertexo-verification=${row.challenge}`,
          ]);
        });
      owner.acquire('owned DNS', dns, (spy) => {
        spy.mockRestore();
      });
    });
    it('proves cross-site SAML and provisions, maps and revokes a directory member on desktop and phone', async () => {
      const apiOrigin = await api.listen();
      const idp = owner.acquire(
        'owned SAML IdP',
        await createBrowserSamlProvider(appOrigin),
        (value) => value.close(),
      );
      const proxy = owner.acquire(
        'owned HTTPS app',
        await createSamlAppProxy({
          origin: appOrigin,
          apiOrigin,
          webOrigin,
          material: idp.material,
        }),
        (value) => value.close(),
      );
      const control = owner.acquire(
        'owned browser control',
        createServer((incoming, outgoing) => {
          const action = (async () => {
            const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
            const json = (value: unknown) =>
              outgoing
                .writeHead(200, {
                  'content-type': 'application/json',
                  'cache-control': 'no-store',
                })
                .end(JSON.stringify(value));
            if (incoming.method === 'GET' && url.pathname === '/verification') {
              try {
                const link = api.mailedLink(
                  url.searchParams.get('email') ?? '',
                  'verification',
                );
                json({ path: link.pathname + link.search });
              } catch {
                outgoing.writeHead(404).end();
              }
              return;
            }
            if (incoming.method === 'GET' && url.pathname === '/provider') {
              json(idp.configuration);
              return;
            }
            if (incoming.method !== 'POST') {
              outgoing.writeHead(404).end();
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of incoming) {
              if (!Buffer.isBuffer(chunk))
                throw new Error('Owned control byte input required');
              size += chunk.length;
              if (size > 65536) throw new Error('Owned control body too large');
              chunks.push(chunk);
            }
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
            if (url.pathname === '/metadata') idp.registerMetadata(value);
            else {
              const { instanceId } = lifetime.parse(value);
              if (url.pathname === '/browser-opened') {
                opened = true;
                openBrowsers.add(instanceId);
              } else if (
                url.pathname !== '/browser-disposed' ||
                !openBrowsers.delete(instanceId)
              )
                throw new Error('Invalid browser receipt');
            }
            outgoing.writeHead(204).end();
          })();
          pending.add(action);
          void action
            .catch(() => {
              if (!outgoing.headersSent) outgoing.writeHead(400);
              outgoing.end();
            })
            .finally(() => pending.delete(action));
        }),
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => {
              if (error === undefined) resolve();
              else reject(error);
            });
          }),
      );
      await new Promise<void>((resolve, reject) => {
        control.once('error', reject);
        control.listen(0, '127.0.0.1', resolve);
      });
      const address = control.address();
      if (address === null || typeof address === 'string')
        throw new Error('Owned control address missing');
      const environment = {
        ...process.env,
        NODE_ENV: 'production',
        PERTEXO_API_PROXY_TARGET: apiOrigin,
        PERTEXO_LIVE_MAIL_ORIGIN: `http://127.0.0.1:${String(address.port)}`,
        PERTEXO_LIVE_WEB_ORIGIN: appOrigin,
      };
      function start(args: string[], kind: 'vite' | 'browser') {
        const child = spawn(process.execPath, args, {
          cwd: webDirectory,
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        const barrier = ownEditorBrowserProcess(child, kind, {
          browserDisposed: () => opened && openBrowsers.size === 0,
        });
        barriers.push(barrier);
        owner.acquire(`owned ${kind}`, barrier, (value) => value.close());
        child.stdout.pipe(process.stdout);
        child.stderr.pipe(process.stderr);
        return child;
      }
      async function finished(child: ChildProcess) {
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code) => {
            if (code === 0) resolve();
            else
              reject(
                new Error(`Owned SAML browser process exited ${String(code)}`),
              );
          });
        });
      }
      const vite = join(
        dirname(webRequire.resolve('vite/package.json')),
        'bin/vite.js',
      );
      await finished(start([vite, 'build'], 'vite'));
      const preview = start(
        [
          vite,
          'preview',
          '--host',
          '127.0.0.1',
          '--port',
          String(liveWebPort),
          '--strictPort',
        ],
        'vite',
      );
      await waitForOwnedOrganizationPreview(preview, webOrigin);
      await finished(
        start(
          [
            webRequire.resolve('@playwright/test/cli'),
            'test',
            '--config',
            'playwright.live.config.ts',
            'editor/federation/saml.spec.ts',
          ],
          'browser',
        ),
      );
      expect(proxy.proofs).toHaveLength(4);
      expect(
        proxy.proofs.every((proof) => proof.purpose && !proof.ordinary),
      ).toBe(true);
      const accounts = await api
        .database()
        .query<{ count: number }>(
          "select count(*)::int as count from app.auth_accounts account join app.auth_providers provider on provider.id::text=account.provider_id where provider.kind='saml'",
        );
      expect(accounts.rows[0]?.count).toBe(2);
    }, 240_000);
  },
);
