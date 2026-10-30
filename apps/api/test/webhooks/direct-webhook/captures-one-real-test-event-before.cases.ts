import { qualifyWebhookTestEvents } from '../test-events/qualify.js';

import { qualifyWebhookResponseWaiting } from '../responses/qualify.js';
import { randomUUID } from 'node:crypto';

import { it } from 'vitest';

import { createInitialCheckpoint } from '@pertexo/execution';

import { issueBrowserSession } from '../support/browser-session.fixture.js';

import {
  apiPool,
  catalog,
  identityRuntime,
  authoring,
  webhookDatabase,
  encryption,
  testEvents,
  ingressDatabase,
  origin,
  seedWebhook,
  ownerQuery,
} from './fixture.js';
import { silentLogger } from '../../support/silent-logger.js';

export function registerCapturesOneRealTestEventBefore(): void {
  it('captures one real test event before publication, across replicas, with authentication and pin fences', async () => {
    const seed = await seedWebhook('test-event-editor');
    const created = await authoring.createWorkflow({
      actorId: seed.actorId,
      workspaceId: seed.workspaceId,
      name: 'Unpublished webhook sample',
      idempotencyKey: randomUUID(),
      emptyGraph: {
        settings: {},
        nodes: [
          {
            id: 'webhook',
            definition: { key: 'core.webhook', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
          },
        ],
        edges: [],
      },
    });
    const scope = {
      workspaceId: seed.workspaceId,
      workflowId: created.workflowId,
      nodeId: 'webhook',
      actorId: seed.actorId,
    };
    const session = await issueBrowserSession(
      identityRuntime.dependencies.sessions,
      seed.actorId,
    );
    await qualifyWebhookTestEvents({
      origin,
      scope,
      revision: created.draft.revision,
      session,
      store: testEvents,
      ingress: {
        database: ingressDatabase,
        testEvents,
        encryption,
        checkpointFactory: (projection) =>
          createInitialCheckpoint(projection, { catalog }),
        logger: silentLogger,
      },
      authoring,
      apiPool,
      query: ownerQuery,
      issueSession: (userId) =>
        issueBrowserSession(identityRuntime.dependencies.sessions, userId),
    });
  }, 30000);

  it('qualifies durable response waiting across independent API listeners and restart', async () => {
    await qualifyWebhookResponseWaiting({
      ingress: {
        database: webhookDatabase,
        encryption,
        checkpointFactory: (projection) =>
          createInitialCheckpoint(projection, { catalog }),
        logger: silentLogger,
      },
      seed: seedWebhook,
      query: ownerQuery,
    });
  }, 20_000);
}
