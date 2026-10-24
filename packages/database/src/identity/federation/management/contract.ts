import type { createFederationManagementStore } from './repository.js';

import type { FederationSettings } from '@pertexo/contracts';
export type FederationScope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
export type OrganizationSnapshot = NonNullable<
  FederationSettings['organization']
>;

export type FederationCommand = FederationScope &
  Readonly<{ idempotencyKey: string; expectedRevision: number }>;

export type FederationManagementStore = ReturnType<
  typeof createFederationManagementStore
>;
