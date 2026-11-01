import { randomBytes } from 'node:crypto';

import { expect } from 'vitest';
import type { Role } from '@pertexo/workflow-model';

import {
  createInput,
  ownerA,
  randomUUID,
  sealed,
  workspaceA,
} from '../../support/connections.js';
import type { MemberFlow } from './flows.js';
import { connections, existingConnection } from './world.js';

const MANAGERS: readonly Role[] = ['owner', 'admin'];

async function existingOAuth2() {
  const connectionId = randomUUID();
  const secretVersionId = randomUUID();
  await connections.api.createConnection({
    workspaceId: workspaceA,
    actorId: ownerA,
    connectionId,
    secretVersionId,
    providerKey: 'http',
    name: `OAuth2 ${connectionId}`,
    authType: 'oauth2',
    oauth2Settings: {
      grantType: 'client_credentials',
      tokenUrl: 'https://id.example.com/token',
      clientId: 'client',
      scope: '',
      clientAuthentication: 'basic',
      tokenParameters: {},
      requestHosts: { mode: 'any' },
    },
    idempotencyKey: randomUUID(),
    requestHash: 'a'.repeat(64),
    sealed: sealed(3),
  });
  return { connectionId, secretVersionId };
}

export const MANAGE_FLOWS: readonly MemberFlow[] = [
  {
    name: 'createConnection',
    allowed: MANAGERS,
    browsable: false,
    prepare: (actorId) => {
      const input = createInput({ actorId });
      return Promise.resolve({
        connectionId: input.connectionId,
        act: () => connections.api.createConnection(input),
        done: (result) => {
          expect(result).toMatchObject({
            id: input.connectionId,
            createdBy: actorId,
          });
        },
      });
    },
  },
  {
    name: 'findConnectionCreateReplay',
    allowed: MANAGERS,
    browsable: false,
    prepare: (actorId) =>
      Promise.resolve({
        connectionId: randomUUID(),
        act: () =>
          connections.api.findConnectionCreateReplay({
            workspaceId: workspaceA,
            actorId,
            idempotencyKey: `unused-${randomUUID()}`,
            requestHash: 'c'.repeat(64),
          }),
        done: (result) => {
          expect(result).toBeNull();
        },
      }),
  },
  {
    name: 'findConnectionRotateReplay',
    allowed: MANAGERS,
    browsable: false,
    prepare: async (actorId) => {
      const input = await existingConnection();
      return {
        connectionId: input.connectionId,
        act: (connectionId) =>
          connections.api.findConnectionRotateReplay({
            workspaceId: workspaceA,
            actorId,
            connectionId,
            idempotencyKey: `unused-${randomUUID()}`,
            requestHash: 'c'.repeat(64),
          }),
        done: (result) => {
          expect(result).toBeNull();
        },
      };
    },
  },
  {
    name: 'rotateConnectionSecret',
    allowed: MANAGERS,
    browsable: false,
    prepare: async (actorId) => {
      const input = await existingConnection();
      const secretVersionId = randomUUID();
      return {
        connectionId: input.connectionId,
        act: (connectionId) =>
          connections.api.rotateConnectionSecret({
            workspaceId: workspaceA,
            actorId,
            connectionId,
            expectedCurrentSecretVersionId: input.secretVersionId,
            secretVersionId,
            sealed: sealed(2),
            idempotencyKey: `rotate-${randomUUID()}`,
            requestHash: 'd'.repeat(64),
          }),
        done: (result) => {
          expect(result).toMatchObject({
            currentSecretVersionId: secretVersionId,
          });
        },
      };
    },
  },
  {
    name: 'revokeConnection',
    allowed: MANAGERS,
    browsable: false,
    prepare: async (actorId) => {
      const input = await existingConnection();
      return {
        connectionId: input.connectionId,
        act: (connectionId) =>
          connections.api.revokeConnection({
            workspaceId: workspaceA,
            actorId,
            connectionId,
          }),
        done: (result) => {
          expect(result).toMatchObject({ status: 'revoked' });
        },
      };
    },
  },
  {
    name: 'readConnectionSharing',
    allowed: MANAGERS,
    browsable: false,
    prepare: async (actorId) => {
      const input = await existingConnection();
      return {
        connectionId: input.connectionId,
        act: (connectionId) =>
          connections.api.readConnectionSharing({
            workspaceId: workspaceA,
            actorId,
            connectionId,
          }),
        done: (result) => {
          expect(result).toMatchObject({
            connectionId: input.connectionId,
            mode: 'workspace',
          });
        },
      };
    },
  },
  {
    name: 'replaceConnectionSharing',
    allowed: MANAGERS,
    browsable: false,
    prepare: async (actorId) => {
      const input = await existingConnection();
      const { revision } = await connections.api.readConnectionSharing({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
      });
      return {
        connectionId: input.connectionId,
        act: (connectionId) =>
          connections.api.replaceConnectionSharing({
            workspaceId: workspaceA,
            actorId,
            connectionId,
            idempotencyKey: `share-${randomUUID()}`,
            request: {
              mode: 'restricted',
              userIds: [],
              expectedSharingRevision: revision,
            },
          }),
        done: (result) => {
          expect(result).toMatchObject({
            mode: 'restricted',
            revision: revision + 1,
            replayed: false,
          });
        },
      };
    },
  },
  {
    name: 'readOAuth2Client',
    allowed: MANAGERS,
    browsable: false,
    prepare: async (actorId) => {
      const { connectionId } = await existingOAuth2();
      return {
        connectionId,
        act: (id) =>
          connections.api.readOAuth2Client({
            workspaceId: workspaceA,
            actorId,
            connectionId: id,
          }),
        done: (result) => {
          expect(result).toMatchObject({
            connection: { id: connectionId },
            settings: { clientId: 'client' },
          });
        },
      };
    },
  },
  {
    name: 'startOAuth2Authorization',
    allowed: MANAGERS,
    browsable: false,
    prepare: async (actorId) => {
      const { connectionId, secretVersionId } = await existingOAuth2();
      return {
        connectionId,
        act: (id) =>
          connections.api.startOAuth2Authorization({
            workspaceId: workspaceA,
            actorId,
            connectionId: id,
            secretVersionId,
            stateDigest: randomBytes(32),
            bindingDigest: randomBytes(32),
            lifetimeSeconds: 600,
          }),
        done: (result) => {
          expect((result as { expiresAt: unknown }).expiresAt).toBeInstanceOf(
            Date,
          );
        },
      };
    },
  },
];
