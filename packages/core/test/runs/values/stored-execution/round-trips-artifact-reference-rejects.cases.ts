import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  parseStoredExecutionValue,
  serializeStoredExecutionValue,
} from '../../../../src/runs/values/stored-execution.js';
import { StoredExecutionValueInvalidError } from '@pertexo/node-sdk';

export function registerRoundTripsArtifactReferenceRejects(): void {
  it('round-trips an artifact reference and rejects malformed envelopes', () => {
    const artifactId = randomUUID();
    expect(
      parseStoredExecutionValue(
        serializeStoredExecutionValue({
          kind: 'artifact',
          artifactId,
        }),
      ),
    ).toEqual({ kind: 'artifact', artifactId });

    for (const malformed of [
      { kind: 'artifact', artifactId: 'not-a-uuid' },
      {
        kind: 'artifact',
        artifactId: '00000000-0000-0000-8000-000000000000',
      },
      {
        kind: 'artifact',
        artifactId: '00000000-0000-4000-0000-000000000000',
      },
      {
        kind: 'artifact',
        artifactId: artifactId.toUpperCase(),
      },
      { kind: 'artifact', artifactId, extra: true },
      { kind: 'inline' },
      '{not json',
    ]) {
      expect(() => parseStoredExecutionValue(malformed)).toThrow(
        StoredExecutionValueInvalidError,
      );
    }

    const hidden = Object.defineProperty(
      { kind: 'artifact', artifactId },
      'hidden',
      { enumerable: false, value: true },
    );
    expect(() => parseStoredExecutionValue(hidden)).toThrow(
      StoredExecutionValueInvalidError,
    );
  });
}
