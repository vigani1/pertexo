import { describe, expect, it } from 'vitest';

import {
  connectionHealthSnapshotSchema,
  deserializeConnectionHealthMetadata,
} from '../../../src/connections/health/metadata.js';

describe('safe connection health metadata codec', () => {
  it('normalizes legacy absence without inventing evidence', () => {
    const empty = {
      lastRunObservedAt: null,
      lastHealthTransitionAt: null,
      lastHealthTransitionSource: null,
    };
    expect(
      deserializeConnectionHealthMetadata(
        connectionHealthSnapshotSchema.parse({}),
      ),
    ).toEqual(empty);
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
