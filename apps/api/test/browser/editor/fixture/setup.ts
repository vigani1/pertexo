import { createBrowserOidcProvider } from '../federation/oidc-provider.js';
import * as oidcProtocol from '../../../../src/authentication/federation/protocol/oidc.js';
import { Resolver } from 'node:dns/promises';
import { createBrowserIdentityProvider } from '../federation/provider.js';
import { useSocialProviderGateway } from '../../../support/better-auth/social-provider.js';

import { fork, type ChildProcess } from 'node:child_process';

import { createServer as createTcpServer } from 'node:net';

import { beforeAll, vi } from 'vitest';
import { z } from 'zod';

import { createEditorHttpControl } from '../http-control.js';

import { httpEffectsSchema } from '../evidence/http.js';

import { curatedTemplateEffectsSchema } from '../../curated-templates/worker-evidence.js';
import {
  scenario,
  webOrigin,
  workerDirectory,
  noticeMailKey,
} from './environment.js';
import { emailDeliveries, fixtureState, noticeMessages } from './state.js';
import { emailDeliveriesSchema } from '../evidence/notifications/email-attachments.js';
import {
  owner,
  ownChild,
  assertHttpDependenciesDisposable,
  assertRestartScopeActive,
  phase,
  recheckOwnership,
} from './lifecycle.js';
import { httpMaster, httpAuthorization, useEditorApiFixture } from './api.js';
import { liveWebPort } from '../../web-origin.js';

export function createEditorBrowserFixture() {
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
      probe.listen(liveWebPort, '127.0.0.1', resolve);
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
      const deliveries = emailDeliveriesSchema.safeParse(value);
      if (deliveries.success && scenario === 'email-attachments') {
        emailDeliveries.splice(0, Infinity, ...deliveries.data.emails);
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
