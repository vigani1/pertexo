import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  createWorkflowFavoriteAbsenceTokenCodec,
  InvalidWorkflowFavoriteAbsenceTokenError,
} from '../../src/workflow-authoring/favorite-absence-token.js';

const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const scope = Object.freeze({
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workflowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
});
const precondition = Object.freeze({
  generation: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  issuedAtSeconds: 1_790_930_096,
});
const other = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const vector =
  'absent.v1.1790930096.1791016496.gBRfPzWDvSAXbLrWksZx6oZ9oNnFtq5DBajfkq94AHM';
const codec = () => createWorkflowFavoriteAbsenceTokenCodec(key);

function expectInvalid(work: () => unknown): void {
  let caught: unknown;
  try {
    work();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvalidWorkflowFavoriteAbsenceTokenError);
  expect(caught).toMatchObject({
    message: 'workflow favorite absence token is invalid',
  });
  expect(caught).not.toHaveProperty('cause');
}

describe('private favorite absence tokens', () => {
  it('matches a domain-separated HMAC fixed vector across instances', () => {
    expect(codec().issue(scope, precondition)).toBe(vector);
    const proof = codec().verify(vector, scope, precondition.generation);
    expect(proof).toEqual({ ...precondition, expiresAtSeconds: 1_791_016_496 });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(codec())).toBe(true);
    expect(vector).not.toContain(scope.actorId);
    expect(vector).not.toContain(precondition.generation);
    const payload = JSON.stringify({
      v: 1,
      w: scope.workspaceId,
      a: scope.actorId,
      id: scope.workflowId,
      g: precondition.generation,
      i: precondition.issuedAtSeconds,
      e: 1_791_016_496,
    });
    const rootMac = createHmac('sha256', key)
      .update(payload)
      .digest('base64url');
    expect(vector.endsWith(rootMac)).toBe(false);
    expectInvalid(() =>
      codec().verify(
        `absent.v1.1790930096.1791016496.${rootMac}`,
        scope,
        precondition.generation,
      ),
    );
  });

  it('copies injected key bytes and does not mutate frozen inputs', () => {
    const supplied = Uint8Array.from(key);
    const instance = createWorkflowFavoriteAbsenceTokenCodec(supplied);
    expect(supplied).toEqual(key);
    supplied.fill(255);
    expect(instance.issue(scope, precondition)).toBe(vector);
    expect(
      instance.verify(vector, scope, precondition.generation),
    ).toMatchObject(precondition);
    expect(scope.actorId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(precondition.issuedAtSeconds).toBe(1_790_930_096);
  });

  it.each([0, 31, 33])('rejects a %i-byte key without fallback', (length) => {
    expect(() =>
      createWorkflowFavoriteAbsenceTokenCodec(new Uint8Array(length)),
    ).toThrow('Workflow favorite absence token key must contain 32 bytes.');
  });

  it('fits the largest valid time fields within 128 ASCII bytes', () => {
    const maximum = {
      ...precondition,
      issuedAtSeconds: 253_402_300_799 - 86_400,
    };
    const token = codec().issue(scope, maximum);
    expect(Buffer.byteLength(token, 'ascii')).toBeLessThanOrEqual(128);
    expect(token).toMatch(
      /^absent\.v1\.253402214399\.253402300799\.[A-Za-z0-9_-]{43}(?![\s\S])/u,
    );
    expect(codec().verify(token, scope, maximum.generation)).toEqual({
      ...maximum,
      expiresAtSeconds: 253_402_300_799,
    });
  });

  it.each([{ workspaceId: other }, { actorId: other }, { workflowId: other }])(
    'rejects a changed scope %j',
    (changed) => {
      expectInvalid(() =>
        codec().verify(
          vector,
          { ...scope, ...changed },
          precondition.generation,
        ),
      );
    },
  );

  it('fences recreation generations while accepting an unchanged generation', () => {
    expectInvalid(() => codec().verify(vector, scope, other));
    expect(
      codec().verify(vector, scope, precondition.generation),
    ).toMatchObject(precondition);
  });

  it('requires a fresh token after key rotation', () => {
    const rotated = createWorkflowFavoriteAbsenceTokenCodec(
      new Uint8Array(32).fill(7),
    );
    expectInvalid(() => rotated.verify(vector, scope, precondition.generation));
    expect(
      rotated.verify(
        rotated.issue(scope, precondition),
        scope,
        precondition.generation,
      ),
    ).toMatchObject(precondition);
  });

  it('returns authenticated expired-looking and future-looking proofs for SQL clock policy', () => {
    for (const issuedAtSeconds of [0, 253_402_214_399]) {
      const issued = { ...precondition, issuedAtSeconds };
      const token = codec().issue(scope, issued);
      expect(codec().verify(token, scope, issued.generation)).toEqual({
        ...issued,
        expiresAtSeconds: issuedAtSeconds + 86_400,
      });
    }
  });

  it.each([-1, 0.5, NaN, Infinity, 253_402_214_400, Number.MAX_SAFE_INTEGER])(
    'rejects issuance time %s',
    (issuedAtSeconds) => {
      expectInvalid(() =>
        codec().issue(scope, { ...precondition, issuedAtSeconds }),
      );
    },
  );

  it.each([
    '',
    'absent',
    'x'.repeat(129),
    `${vector}.extra`,
    vector.replace('v1', 'v2'),
    vector.replace('1790930096', '01790930096'),
    vector.replace('1790930096', '-1790930096'),
    vector.replace('1790930096', '1790930096e0'),
    vector.replace('1790930096', '1790930096.0'),
    vector.replace('1791016496', '1791016497'),
    vector.replace('1791016496', '253402300800'),
    `${vector}=`,
    `${vector.slice(0, -1)}N`,
    `${vector.slice(0, -2)}AA`,
    vector.slice(0, -1),
    `${vector}A`,
    vector.replace('absent', 'ABSENT'),
  ])('rejects malformed or noncanonical wire %#', (token) => {
    expectInvalid(() => codec().verify(token, scope, precondition.generation));
  });

  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])(
    'uses true end-of-string for protocol text %#',
    (separator) => {
      expectInvalid(() =>
        codec().verify(`${vector}${separator}`, scope, precondition.generation),
      );
      expectInvalid(() =>
        codec().issue(
          { ...scope, actorId: `${scope.actorId}${separator}` },
          precondition,
        ),
      );
      expectInvalid(() =>
        codec().issue(scope, {
          ...precondition,
          generation: `${precondition.generation}${separator}`,
        }),
      );
      expectInvalid(() =>
        codec().verify(vector, scope, `${precondition.generation}${separator}`),
      );
    },
  );

  it('rejects noncanonical UUIDs and unknown scope/precondition fields', () => {
    expectInvalid(() =>
      codec().issue(
        { ...scope, actorId: scope.actorId.toUpperCase() },
        precondition,
      ),
    );
    expectInvalid(() =>
      codec().verify(
        vector,
        { ...scope, workflowId: 'invalid' },
        precondition.generation,
      ),
    );
    expectInvalid(() =>
      codec().verify(vector, scope, precondition.generation.toUpperCase()),
    );
    const extraScope = { ...scope, userId: other };
    const extraPrecondition = {
      ...precondition,
      expiresAtSeconds: 1_791_016_496,
    };
    expectInvalid(() => codec().issue(extraScope, precondition));
    expectInvalid(() =>
      codec().verify(vector, extraScope, precondition.generation),
    );
    expectInvalid(() => codec().issue(scope, extraPrecondition));
  });
});
