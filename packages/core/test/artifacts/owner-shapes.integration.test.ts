import { expect, it } from 'vitest';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { visibleArtifactIds } from '../../src/artifacts/references/access.repository.js';
import { workspaceId, userId } from '../lifecycle/retention.support.js';
import {
  artifactOwnerFixture,
  ownerLocations,
} from './owner-shapes.fixture.js';

it.each(ownerLocations)(
  'treats an incidental artifactId as business data in %s for access and retention',
  async (location) => {
    const state = await artifactOwnerFixture(location, 'business-id');
    try {
      const visible = await withTenantScopedClient(
        state.pool,
        { workspaceId },
        (client) =>
          visibleArtifactIds(client, { workspaceId, actorId: userId }, [
            state.reference.artifactId,
          ]),
      );
      expect([...visible]).toEqual([]);
      await expect(state.coordinator.processNext()).resolves.toMatchObject({
        status: 'completed',
        artifactId: state.reference.artifactId,
      });
      expect(state.store.delete).toHaveBeenCalledOnce();
    } finally {
      await state.close();
    }
  },
);

it.each(ownerLocations)(
  'retains and exposes a real descriptor in %s',
  async (location) => {
    const state = await artifactOwnerFixture(location, 'descriptor');
    try {
      const visible = await withTenantScopedClient(
        state.pool,
        { workspaceId },
        (client) =>
          visibleArtifactIds(client, { workspaceId, actorId: userId }, [
            state.reference.artifactId,
          ]),
      );
      expect([...visible]).toEqual([state.reference.artifactId]);
      await expect(state.coordinator.processNext()).resolves.toMatchObject({
        status: 'referenced',
        artifactId: state.reference.artifactId,
      });
      expect(state.store.delete).not.toHaveBeenCalled();
    } finally {
      await state.close();
    }
  },
);

// Samples require an inline envelope; their descriptors are covered above.
it.each([
  'preview-input',
  'preview-output',
  'run-input',
  'run-output',
  'node-input',
  'node-output',
  'attempt-output',
  'attempt-reconciliation',
  'event',
  'checkpoint',
  'task-response',
] as const)(
  'retains the canonical stored artifact envelope in %s without requiring descriptor metadata',
  async (location) => {
    const state = await artifactOwnerFixture(location, 'execution-reference');
    try {
      const visible = await withTenantScopedClient(
        state.pool,
        { workspaceId },
        (client) =>
          visibleArtifactIds(client, { workspaceId, actorId: userId }, [
            state.reference.artifactId,
          ]),
      );
      expect([...visible]).toEqual([state.reference.artifactId]);
      await expect(state.coordinator.processNext()).resolves.toMatchObject({
        status: 'referenced',
        artifactId: state.reference.artifactId,
      });
    } finally {
      await state.close();
    }
  },
);
