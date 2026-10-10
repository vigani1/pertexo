import { describe, expect, it } from 'vitest';

import {
  connectionHealthSnapshotSchema,
  deserializeConnectionHealthMetadata,
  mapConnectionHealthMetadata,
} from '../../../src/connections/health/metadata.js';

describe('safe connection health metadata codec', () => {
  it('normalizes legacy absence without inventing evidence', () => {
    const empty = {
      lastRunObservedAt: null,
      lastHealthTransitionAt: null,
      lastHealthTransitionSource: null,
    };
    expect(mapConnectionHealthMetadata({})).toEqual(empty);
    expect(
      deserializeConnectionHealthMetadata(
        connectionHealthSnapshotSchema.parse({}),
      ),
    ).toEqual(empty);
  });

  it('projects only validated provenance from database rows', () => {
    const time = new Date('2026-10-01T00:00:00.000Z');
    expect(
      mapConnectionHealthMetadata({
        last_run_observed_at: time,
        last_health_transition_at: time,
        last_health_transition_source: 'run',
        health_revision: 17n,
        secret_version_id: 'private',
      }),
    ).toEqual({
      lastRunObservedAt: time,
      lastHealthTransitionAt: time,
      lastHealthTransitionSource: 'run',
    });
    expect(() =>
      mapConnectionHealthMetadata({ last_run_observed_at: 'invalid' }),
    ).toThrow();
    expect(() =>
      mapConnectionHealthMetadata({
        last_health_transition_source: 'provider-body',
      }),
    ).toThrow();
  });

  it('decodes durable dates and rejects invalid or unrecognized provenance', () => {
    const time = '2026-10-01T00:00:00.000Z';
    expect(
      deserializeConnectionHealthMetadata(
        connectionHealthSnapshotSchema.parse({
          lastRunObservedAt: time,
          lastHealthTransitionAt: time,
          lastHealthTransitionSource: 'test',
        }),
      ),
    ).toEqual({
      lastRunObservedAt: new Date(time),
      lastHealthTransitionAt: new Date(time),
      lastHealthTransitionSource: 'test',
    });
    expect(
      connectionHealthSnapshotSchema.safeParse({
        lastHealthTransitionAt: 'invalid',
      }).success,
    ).toBe(false);
    expect(
      connectionHealthSnapshotSchema.safeParse({
        lastHealthTransitionSource: 'credential',
      }).success,
    ).toBe(false);
  });
});
