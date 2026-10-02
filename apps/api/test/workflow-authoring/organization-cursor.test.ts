import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { InvalidWorkflowCursorError } from '../../src/workflow-authoring/cursor.js';
import {
  createWorkflowOrganizationCursorCodec,
  type WorkflowOrganizationCursorContext,
} from '../../src/workflow-authoring/organization-cursor.js';

const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const now = 1_790_930_096_000;
const context: WorkflowOrganizationCursorContext = {
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  order: 'created_asc',
  filterHash: 'ab'.repeat(32),
};
const position = {
  positionAt: '2026-10-02T12:34:56.123456Z',
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const payload = {
  v: 1,
  w: context.workspaceId,
  a: context.actorId,
  o: context.order,
  f: context.filterHash,
  t: position.positionAt,
  id: position.id,
  i: now / 1000,
  e: now / 1000 + 900,
};
const fixedVector =
  'eyJ2IjoxLCJ3IjoiYWFhYWFhYWEtYWFhYS00YWFhLThhYWEtYWFhYWFhYWFhYWFhIiwiYSI6ImJiYmJiYmJiLWJiYmItNGJiYi04YmJiLWJiYmJiYmJiYmJiYiIsIm8iOiJjcmVhdGVkX2FzYyIsImYiOiJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiIiwidCI6IjIwMjYtMTAtMDJUMTI6MzQ6NTYuMTIzNDU2WiIsImlkIjoiY2NjY2NjY2MtY2NjYy00Y2NjLThjY2MtY2NjY2NjY2NjY2NjIiwiaSI6MTc5MDkzMDA5NiwiZSI6MTc5MDkzMDk5Nn0.1b1i9yNW2HHugs84_lqt_jQPKOjjT2myoEr8AGBXFkY';

function signedBytes(bytes: Buffer): string {
  return `${bytes.toString('base64url')}.${createHmac('sha256', key).update(bytes).digest('base64url')}`;
}
function signed(value: unknown): string {
  return signedBytes(Buffer.from(JSON.stringify(value), 'utf8'));
}
function codec(time = now) {
  return createWorkflowOrganizationCursorCodec(key, () => time);
}
function expectInvalid(work: () => unknown): void {
  let caught: unknown;
  try {
    work();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvalidWorkflowCursorError);
  expect(caught).toMatchObject({ message: 'workflow cursor is invalid' });
  expect(caught).not.toHaveProperty('cause');
}

describe('signed workflow organization cursors', () => {
  it('matches a fixed HMAC-SHA256 vector across separately constructed instances', () => {
    expect(codec().encode(context, position)).toBe(fixedVector);
    expect(codec().decode(fixedVector, context)).toEqual(position);
    expect(Object.isFrozen(codec())).toBe(true);
    expect(Object.isFrozen(codec().decode(fixedVector, context))).toBe(true);
  });

  it('copies the injected key rather than retaining caller-owned mutable bytes', () => {
    const supplied = Uint8Array.from(key);
    const owned = createWorkflowOrganizationCursorCodec(supplied, () => now);
    supplied.fill(255);
    expect(owned.encode(context, position)).toBe(fixedVector);
  });

  it.each([0, 31, 33])('refuses a %i-byte key with no fallback', (length) => {
    expect(() =>
      createWorkflowOrganizationCursorCodec(new Uint8Array(length)),
    ).toThrow('Workflow organization cursor key must contain 32 bytes.');
  });

  it('fits the largest legitimate payload and preserves exact microsecond position', () => {
    const largest = codec((253_402_300_799 - 900) * 1000 + 999);
    const maximumPosition = {
      ...position,
      positionAt: '9999-12-31T23:59:59.999999Z',
    };
    const scope = { ...context, order: 'updated_desc' as const };
    const wire = largest.encode(scope, maximumPosition);
    expect(Buffer.byteLength(wire, 'ascii')).toBeLessThanOrEqual(512);
    expect(wire).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
    expect(largest.decode(wire, scope)).toEqual(maximumPosition);
    expectInvalid(() => codec(253_402_300_799_000).encode(context, position));
  });

  it('floors integer millisecond clocks and rejects invalid clock values', () => {
    expect(codec(now + 999).encode(context, position)).toBe(fixedVector);
    for (const time of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER]) {
      expectInvalid(() => codec(time).encode(context, position));
      expectInvalid(() => codec(time).decode(fixedVector, context));
    }
  });

  it('expires at precisely fifteen minutes and rejects issuance in the future', () => {
    expect(codec(now + 899_999).decode(fixedVector, context)).toEqual(position);
    expectInvalid(() => codec(now + 900_000).decode(fixedVector, context));
    expectInvalid(() => codec(now - 1).decode(fixedVector, context));
  });

  it.each([
    { workspaceId: position.id },
    { actorId: position.id },
    { order: 'updated_desc' as const },
    { filterHash: 'cd'.repeat(32) },
  ])('binds the current scope/filter/order: %j', (changed) => {
    expectInvalid(() =>
      codec().decode(fixedVector, { ...context, ...changed }),
    );
  });

  it('invalidates a cursor after key rotation', () => {
    expectInvalid(() =>
      createWorkflowOrganizationCursorCodec(
        new Uint8Array(32).fill(9),
        () => now,
      ).decode(fixedVector, context),
    );
  });

  it('rejects payload and signature tampering without disclosing input', () => {
    const changedPayload = Buffer.from(
      JSON.stringify({ ...payload, f: 'cd'.repeat(32) }),
    ).toString('base64url');
    const signature = fixedVector.split('.')[1] ?? '';
    expectInvalid(() =>
      codec().decode(`${changedPayload}.${signature}`, context),
    );
    expectInvalid(() =>
      codec().decode(`${fixedVector.slice(0, -2)}AA`, context),
    );
  });

  it.each([
    '',
    'x'.repeat(513),
    'é'.repeat(256),
    `${fixedVector}.x`,
    fixedVector.replace('.', '=.'),
    `${fixedVector}=`,
    // Alternate final sextet decodes to the same MAC but is noncanonical.
    `${fixedVector.slice(0, -1)}Z`,
    signedBytes(Buffer.from([255])),
    signedBytes(Buffer.from('{')),
    signed({ ...payload, extra: true }),
    signed({ ...payload, v: 2 }),
    signed({ ...payload, i: -1 }),
    signed({ ...payload, i: payload.i + 0.5 }),
    signed({ ...payload, e: payload.e - 1 }),
    signed({ ...payload, e: 253_402_300_800 }),
    signed({ ...payload, w: context.workspaceId.toUpperCase() }),
    signed({ ...payload, f: context.filterHash.toUpperCase() }),
    signedBytes(Buffer.from(` ${JSON.stringify(payload)}`)),
    signed(Object.fromEntries(Object.entries(payload).reverse())),
    signedBytes(
      Buffer.from(JSON.stringify(payload).replace('"v":1', '"v":1,"v":1')),
    ),
    signedBytes(
      Buffer.from(JSON.stringify({ ...payload, extra: 'x'.repeat(512) })),
    ),
  ])('rejects malformed, noncanonical or oversized wire %#', (wire) => {
    expectInvalid(() => codec().decode(wire, context));
  });

  it.each([
    '2026-02-30T12:34:56Z',
    '2026-10-02T24:00:00Z',
    '2026-10-02T12:34:60Z',
    '0000-01-01T00:00:00Z',
    '2026-10-02T12:34:56.1234567Z',
    '2026-10-02T12:34:56+00:00',
    '2026-10-02T12:34:56z',
    'not-a-timestamp',
  ])('rejects invalid exact timestamps %s even when signed', (timestamp) => {
    expectInvalid(() =>
      codec().encode(context, { ...position, positionAt: timestamp }),
    );
    expectInvalid(() =>
      codec().decode(signed({ ...payload, t: timestamp }), context),
    );
  });

  it.each([
    '2026-10-02T12:34:56Z',
    '2026-10-02T12:34:56.1Z',
    '2024-02-29T00:00:00.000001Z',
  ])('preserves supported timestamp spelling %s', (timestamp) => {
    const exact = { ...position, positionAt: timestamp };
    expect(codec().decode(codec().encode(context, exact), context)).toEqual(
      exact,
    );
  });

  it('strictly validates injected context and position on encode and decode', () => {
    expectInvalid(() =>
      codec().encode({ ...context, filterHash: 'raw private query' }, position),
    );
    expectInvalid(() =>
      codec().decode(fixedVector, {
        ...context,
        filterHash: 'raw private query',
      }),
    );
    expectInvalid(() =>
      codec().encode(
        { ...context, actorId: context.actorId.toUpperCase() },
        position,
      ),
    );
    expectInvalid(() =>
      codec().encode(context, { ...position, id: 'invalid' }),
    );
  });
  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])(
    'rejects terminal line separators in every protocol text field %#',
    (separator) => {
      const invalidContext = {
        ...context,
        filterHash: `${context.filterHash}${separator}`,
      };
      expectInvalid(() => codec().encode(invalidContext, position));
      expectInvalid(() => codec().decode(fixedVector, invalidContext));
      expectInvalid(() =>
        codec().decode(
          signed({ ...payload, f: invalidContext.filterHash }),
          context,
        ),
      );
      // Keep the suffixed timestamp within the independent 27-byte bound.
      const timestamp = `2026-10-02T12:34:56Z${separator}`;
      expectInvalid(() =>
        codec().encode(context, { ...position, positionAt: timestamp }),
      );
      expectInvalid(() =>
        codec().decode(signed({ ...payload, t: timestamp }), context),
      );
      expectInvalid(() =>
        codec().decode(`${fixedVector}${separator}`, context),
      );
      expectInvalid(() =>
        codec().decode(fixedVector.replace('.', `${separator}.`), context),
      );
      expectInvalid(() =>
        codec().encode(context, {
          ...position,
          id: `${position.id}${separator}`,
        }),
      );
      expectInvalid(() =>
        codec().decode(
          signed({ ...payload, id: `${position.id}${separator}` }),
          context,
        ),
      );
    },
  );
});
