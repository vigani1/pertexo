import { expect } from 'vitest';
import type { Role } from '@pertexo/workflow-model';

import {
  CONNECTION_AUTH_TYPE,
  ConnectionNotFoundError,
  randomUUID,
  workspaceA,
} from '../../support/connections.js';
import { MANAGE_FLOWS } from './manage-flows.js';
import { connections, existingConnection } from './world.js';

/** One attempt, set up while the actor could still act. */
export type Prepared = Readonly<{
  connectionId: string;
  act: (connectionId: string) => Promise<unknown>;
  done: (result: unknown) => void;
}>;

export type MemberFlow = Readonly<{
  name: string;
  allowed: readonly Role[];
  /** Answers in a suspended workspace too. */
  browsable: boolean;
  prepare: (actorId: string) => Promise<Prepared>;
}>;

const USERS: readonly Role[] = ['owner', 'admin', 'builder', 'operator'];
const EVERY_ROLE: readonly Role[] = [...USERS, 'viewer'];

/**
 * A claim the actor owns, if the actor may start one. Someone who may not still
 * gets to try the next step with these values, and must be refused for who they
 * are rather than for the claim.
 */
async function claimedBy(actorId: string) {
  const input = await existingConnection();
  const claim = {
    workspaceId: workspaceA,
    actorId,
    idempotencyKey: `access-${randomUUID()}`,
    requestHash: 'b'.repeat(64),
    dispatchToken: randomUUID(),
  };
  await connections.api
    .startConnectionTest({
      ...claim,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
    })
    .catch((error: unknown) => {
      if (!(error instanceof ConnectionNotFoundError)) throw error;
    });
  return { input, claim };
}

export const MEMBER_FLOWS: readonly MemberFlow[] = [
  ...MANAGE_FLOWS,
  {
    name: 'listConnections',
    allowed: EVERY_ROLE,
    browsable: true,
    prepare: async (actorId) => {
      const input = await existingConnection();
      return {
        connectionId: input.connectionId,
        act: () =>
          connections.api.listConnections({
            workspaceId: workspaceA,
            actorId,
            limit: 1,
          }),
        done: (result) => {
          // The newest active connection comes first.
          expect(result).toMatchObject({
            items: [{ id: input.connectionId }],
          });
        },
      };
    },
  },
  {
    name: 'readConnection',
    allowed: EVERY_ROLE,
    browsable: true,
    prepare: async (actorId) => {
      const input = await existingConnection();
      return {
        connectionId: input.connectionId,
        act: (connectionId) =>
          connections.api.readConnection({
            workspaceId: workspaceA,
            actorId,
            connectionId,
          }),
        done: (result) => {
          expect(result).toMatchObject({ id: input.connectionId });
        },
      };
    },
  },
  {
    name: 'listConnectionUsage',
    allowed: EVERY_ROLE,
    browsable: true,
    prepare: async (actorId) => {
      const input = await existingConnection();
      return {
        connectionId: input.connectionId,
        act: (connectionId) =>
          connections.api.listConnectionUsage({
            workspaceId: workspaceA,
            actorId,
            connectionId,
          }),
        done: (result) => {
          expect(result).toMatchObject({ items: [] });
        },
      };
    },
  },
  {
    name: 'startConnectionTest',
    allowed: USERS,
    browsable: false,
    prepare: async (actorId) => {
      const input = await existingConnection();
      const dispatchToken = randomUUID();
      return {
        connectionId: input.connectionId,
        act: (connectionId) =>
          connections.api.startConnectionTest({
            workspaceId: workspaceA,
            actorId,
            connectionId,
            expectedProviderKey: 'http',
            idempotencyKey: `start-${randomUUID()}`,
            requestHash: 'e'.repeat(64),
            dispatchToken,
          }),
        done: (result) => {
          expect(result).toEqual({ kind: 'dispatch', dispatchToken });
        },
      };
    },
  },
  {
    name: 'resolveConnectionTestSecret',
    allowed: USERS,
    browsable: false,
    prepare: async (actorId) => {
      const { input, claim } = await claimedBy(actorId);
      return {
        connectionId: input.connectionId,
        act: (connectionId) =>
          connections.api.resolveConnectionTestSecret({
            ...claim,
            connectionId,
            expectedProviderKey: 'http',
          }),
        done: (result) => {
          expect(result).toMatchObject({
            secretVersionId: input.secretVersionId,
          });
        },
      };
    },
  },
  {
    name: 'markConnectionTestDispatched',
    allowed: USERS,
    browsable: false,
    prepare: async (actorId) => {
      const { input, claim } = await claimedBy(actorId);
      await connections.api
        .resolveConnectionTestSecret({
          ...claim,
          connectionId: input.connectionId,
          expectedProviderKey: 'http',
        })
        .catch((error: unknown) => {
          if (!(error instanceof ConnectionNotFoundError)) throw error;
        });
      return {
        connectionId: input.connectionId,
        act: (connectionId) =>
          connections.api.markConnectionTestDispatched({
            ...claim,
            connectionId,
            secretVersionId: input.secretVersionId,
          }),
        done: (result) => {
          expect(result).toBeUndefined();
        },
      };
    },
  },
  {
    name: 'resolveConnectionLookupSecret',
    allowed: USERS,
    browsable: false,
    prepare: async (actorId) => {
      const input = await existingConnection({
        providerKey: 'slack',
        authType: CONNECTION_AUTH_TYPE.slackBotToken,
      });
      return {
        connectionId: input.connectionId,
        act: (connectionId) =>
          connections.api.resolveConnectionLookupSecret({
            workspaceId: workspaceA,
            actorId,
            connectionId,
            expectedProviderKey: 'slack',
            purpose: 'slack.channel_lookup',
          }),
        done: (result) => {
          expect(result).toMatchObject({
            secretVersionId: input.secretVersionId,
          });
        },
      };
    },
  },
];
