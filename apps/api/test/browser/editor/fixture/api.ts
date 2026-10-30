import type { createBrowserOidcProvider } from '../federation/oidc-provider.js';

import {
  createArtifactStore,
  parseArtifactStoreConfig,
} from '@pertexo/artifact-store';

import type { ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import { Pool } from 'pg';
import {
  ConnectionEnvelopeEncryption,
  type ConnectionSecretContext,
} from '@pertexo/integrations/server';
import { createEditorBrowserEnvelopeKeys } from '../../../../../../infrastructure/testing/editor-browser-envelope-keys.mjs';
import { createCuratedTemplateEnvelopeContext } from '../../../../../../infrastructure/testing/curated-template-envelope-context.mjs';
import { createEditorWebhookRuntime } from '../webhook-runtime.js';

import { createStructuredLogger } from '@pertexo/observability';

import { useBetterAuthRealApi } from '../../../support/better-auth/real-api.support.js';

import {
  scenario,
  webOrigin,
  callbackConfig,
  noticeMailKey,
  controlledHttpScenario,
  artifactScenario,
} from './environment.js';
import {
  owner,
  browserChildren,
  restartScope,
  phase,
  recheckOwnership,
  closeChild,
} from './lifecycle.js';
import type { EditorBrowserApi } from './contract.js';

export const httpMaster =
  controlledHttpScenario ||
  scenario === 'curated-templates' ||
  scenario === 'webhook-responses' ||
  scenario === 'email-attachments'
    ? randomBytes(32)
    : undefined;

export const httpAuthorization = editorHttpAuthorization();

function editorHttpAuthorization() {
  if (!controlledHttpScenario) return undefined;
  if (scenario === 'artifact-inputs')
    return 'Bearer owned-artifact-destination';
  return `Bearer ${randomUUID()}`;
}

export function useEditorApiFixture(context: {
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
      'form-uploads',
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
    ...(artifactScenario ? { artifacts: parseArtifactStoreConfig() } : {}),
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
      services: () => ({
        // Discovery/authorization/persistence are real. This pure-node gate
        // neither provisions credentials nor permits outbound provider calls.
        encryption:
          httpMaster === undefined
            ? {
                encryption: {
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
            : connectionEnvelope(scenario, httpMaster),
        http: {
          execute: () =>
            Promise.reject(
              new Error('Provider calls are outside the pure-node gate'),
            ),
        },
      }),
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
      if (artifactScenario) {
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

function connectionEnvelope(scenario: string, httpMaster: Buffer) {
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
}
