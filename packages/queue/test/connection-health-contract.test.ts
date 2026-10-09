import { describe, expect, it } from 'vitest';
import {
  JOB_NAME,
  QUEUE_FOR_JOB,
  QUEUE_NAME,
  parseQueueJob,
} from '../src/index.js';

const data = {
  schemaVersion: 1,
  workspaceId: '11111111-1111-4111-8111-111111111111',
  outboxEventId: '22222222-2222-4222-8222-222222222222',
  observationId: '33333333-3333-4333-8333-333333333333',
};

describe('ID-only connection health application job', () => {
  it('uses the existing maintenance queue and active typed registry', () => {
    expect(
      parseQueueJob({ name: JOB_NAME.applyConnectionHealthObservation, data }),
    ).toEqual({ name: JOB_NAME.applyConnectionHealthObservation, data });
    expect(QUEUE_FOR_JOB[JOB_NAME.applyConnectionHealthObservation]).toBe(
      QUEUE_NAME.maintenance,
    );
  });
  it.each([
    'connectionId',
    'status',
    'reasonCode',
    'mode',
    'secretVersionId',
    'healthRevision',
    'providerBody',
  ])('rejects caller-selected %s', (field) => {
    expect(() =>
      parseQueueJob({
        name: JOB_NAME.applyConnectionHealthObservation,
        data: { ...data, [field]: 'untrusted' },
      }),
    ).toThrow();
  });
  it('rejects malformed identity and versions', () => {
    for (const invalid of [
      { ...data, observationId: 'bad' },
      { ...data, schemaVersion: 2 },
      { ...data, workspaceId: undefined },
    ])
      expect(() =>
        parseQueueJob({
          name: JOB_NAME.applyConnectionHealthObservation,
          data: invalid,
        }),
      ).toThrow();
  });
});
