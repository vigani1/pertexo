import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { InvalidWorkflowCursorError } from '../../src/workflow-authoring/cursor.js';
import {
  createWorkflowOrganizationPageCursorCodec,
  type WorkflowOrganizationPageCursorContext,
} from '../../src/workflow-authoring/organization-page-cursor.js';

const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const now = 1_790_930_096_000;
const context: WorkflowOrganizationPageCursorContext = Object.freeze({
  purpose: 'tags',
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  selectedTagId: null,
});
const position = Object.freeze({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
const selectedTagId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const assignments: WorkflowOrganizationPageCursorContext = Object.freeze({
  ...context,
  purpose: 'tag-assignments',
  selectedTagId,
});
const payload = {
  v: 1,
  p: 'tags',
  w: context.workspaceId,
  a: context.actorId,
  s: null,
  id: position.id,
  i: now / 1000,
  e: now / 1000 + 900,
};
const fixedVector =
  'eyJ2IjoxLCJwIjoidGFncyIsInciOiJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJhIjoiYmJiYmJiYmItYmJiYi00YmJiLThiYmItYmJiYmJiYmJiYmJiIiwicyI6bnVsbCwiaWQiOiJjY2NjY2NjYy1jY2NjLTRjY2MtOGNjYy1jY2NjY2NjY2NjY2MiLCJpIjoxNzkwOTMwMDk2LCJlIjoxNzkwOTMwOTk2fQ.c-wtoj3au3I1OO0rLbS4m8egfSWDVWur4Xw2L1w0zIQ';

function codec(time = now) {
  return createWorkflowOrganizationPageCursorCodec(key, () => time);
}
function signedBytes(
  bytes: Buffer,
  signingKey = createHmac('sha256', key)
    .update('pertexo.workflow.organization.page-cursor-key.v1')
    .digest(),
): string {
  return `${bytes.toString('base64url')}.${createHmac('sha256', signingKey).update(bytes).digest('base64url')}`;
}
function signed(value: unknown): string {
  return signedBytes(Buffer.from(JSON.stringify(value), 'utf8'));
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

describe('purpose-bound workflow organization UUID page cursors', () => {
  it('matches a stable fixed algorithm vector across instances', () => {
    expect(codec().encode(context, position)).toBe(fixedVector);
    expect(codec().decode(fixedVector, context)).toEqual(position);
    expect(Object.isFrozen(codec())).toBe(true);
    expect(Object.isFrozen(codec().decode(fixedVector, context))).toBe(true);
  });

  it('copies the injected root without mutating it or the frozen inputs', () => {
    const supplied = Uint8Array.from(key);
    const owned = createWorkflowOrganizationPageCursorCodec(
      supplied,
      () => now,
    );
    expect(supplied).toEqual(key);
    supplied.fill(255);
    expect(owned.encode(context, position)).toBe(fixedVector);
    expect(owned.decode(fixedVector, context)).toEqual(position);
  });

  it.each([0, 31, 33])('rejects a %i-byte root without fallback', (length) => {
    expect(() =>
      createWorkflowOrganizationPageCursorCodec(new Uint8Array(length)),
    ).toThrow('Workflow organization page cursor key must contain 32 bytes.');
  });

  it('domain-separates from the root and favorite absence subkey', () => {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    expectInvalid(() =>
      codec().decode(signedBytes(bytes, Buffer.from(key)), context),
    );
    const favoriteKey = createHmac('sha256', key)
      .update('pertexo.workflow.favorite.absence-key.v1')
      .digest();
    expectInvalid(() =>
      codec().decode(signedBytes(bytes, favoriteKey), context),
    );
  });

  it('round-trips assignments with a selected tag and binds its purpose', () => {
    const wire = codec().encode(assignments, position);
    expect(codec().decode(wire, assignments)).toEqual(position);
    expectInvalid(() => codec().decode(wire, context));
    expectInvalid(() => codec().decode(fixedVector, assignments));
    expectInvalid(() =>
      codec().decode(wire, { ...assignments, selectedTagId: position.id }),
    );
  });

  it.each([{ workspaceId: position.id }, { actorId: position.id }])(
    'binds current scope %j',
    (changed) => {
      expectInvalid(() =>
        codec().decode(fixedVector, { ...context, ...changed }),
      );
    },
  );

  it('keeps the largest legitimate assignment payload inside the 512 ASCII wire limit', () => {
    const maximum = codec((253_402_300_799 - 900) * 1000 + 999);
    const wire = maximum.encode(assignments, position);
    expect(Buffer.byteLength(wire, 'ascii')).toBeLessThanOrEqual(512);
    expect(wire).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}(?![\s\S])/u);
    expect(maximum.decode(wire, assignments)).toEqual(position);
    expectInvalid(() => codec(253_402_300_799_000).encode(context, position));
  });

  it('uses exact 900-second expiry, rejects future issuance, and floors integer millisecond clocks', () => {
    expect(codec(now + 999).encode(context, position)).toBe(fixedVector);
    expect(codec(now + 899_999).decode(fixedVector, context)).toEqual(position);
    expectInvalid(() => codec(now + 900_000).decode(fixedVector, context));
    expectInvalid(() => codec(now - 1).decode(fixedVector, context));
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER])(
    'rejects invalid clock %s',
    (time) => {
      expectInvalid(() => codec(time).encode(context, position));
      expectInvalid(() => codec(time).decode(fixedVector, context));
    },
  );

  it('rejects cursors after root rotation', () => {
    expectInvalid(() =>
      createWorkflowOrganizationPageCursorCodec(
        new Uint8Array(32).fill(9),
        () => now,
      ).decode(fixedVector, context),
    );
  });

  it('rejects payload tampering without parsing unauthenticated data', () => {
    const changed = Buffer.from(
      JSON.stringify({ ...payload, id: selectedTagId }),
    ).toString('base64url');
    expectInvalid(() =>
      codec().decode(`${changed}.${fixedVector.split('.')[1] ?? ''}`, context),
    );
  });

  it.each([
    '',
    'x'.repeat(513),
    'é'.repeat(256),
    `${fixedVector}.extra`,
    fixedVector.replace('.', '=.'),
    `${fixedVector}=`,
    `${fixedVector.slice(0, -1)}R`,
    `${fixedVector.slice(0, -2)}AA`,
    signedBytes(Buffer.from([255])),
    signedBytes(Buffer.from('{')),
    signed({ ...payload, extra: true }),
    signed({ ...payload, v: 2 }),
    signed({ ...payload, p: 'workflows' }),
    signed({ ...payload, s: selectedTagId }),
    signed({ ...payload, p: 'tag-assignments' }),
    signed({ ...payload, w: context.workspaceId.toUpperCase() }),
    signed({ ...payload, id: 'invalid' }),
    signed({ ...payload, i: -1 }),
    signed({ ...payload, i: payload.i + 0.5 }),
    signed({ ...payload, e: payload.e - 1 }),
    signed({ ...payload, e: 253_402_300_800 }),
    signedBytes(Buffer.from(` ${JSON.stringify(payload)}`)),
    signed(Object.fromEntries(Object.entries(payload).reverse())),
    signedBytes(
      Buffer.from(JSON.stringify(payload).replace('"v":1', '"v":1,"v":1')),
    ),
    signed({ ...payload, extra: 'x'.repeat(512) }),
  ])(
    'rejects malformed, noncanonical, unsupported or oversized wire %#',
    (wire) => {
      expectInvalid(() => codec().decode(wire, context));
    },
  );

  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])(
    'uses true end-of-string for every protocol text field %#',
    (separator) => {
      expectInvalid(() =>
        codec().decode(`${fixedVector}${separator}`, context),
      );
      expectInvalid(() =>
        codec().decode(fixedVector.replace('.', `${separator}.`), context),
      );
      expectInvalid(() =>
        codec().encode(
          { ...context, actorId: `${context.actorId}${separator}` },
          position,
        ),
      );
      expectInvalid(() =>
        codec().decode(
          signed({ ...payload, id: `${position.id}${separator}` }),
          context,
        ),
      );
      expectInvalid(() =>
        codec().encode(
          { ...assignments, selectedTagId: `${selectedTagId}${separator}` },
          position,
        ),
      );
    },
  );

  it('strictly rejects noncanonical identity, unknown order, and invalid purpose/tag combinations', () => {
    expectInvalid(() =>
      codec().encode(
        { ...context, actorId: context.actorId.toUpperCase() },
        position,
      ),
    );
    expectInvalid(() =>
      codec().encode(context, { id: position.id.toUpperCase() }),
    );
    const wrongTags = { ...assignments, purpose: 'tags' as const };
    const wrongAssignments = {
      ...context,
      purpose: 'tag-assignments' as const,
    };
    // Runtime callers must not bypass the discriminated transport context.
    expectInvalid(() =>
      codec().encode(
        wrongTags as unknown as WorkflowOrganizationPageCursorContext,
        position,
      ),
    );
    expectInvalid(() =>
      codec().encode(
        wrongAssignments as unknown as WorkflowOrganizationPageCursorContext,
        position,
      ),
    );
    const extraContext = { ...context, order: 'descending' };
    expectInvalid(() => codec().encode(extraContext, position));
    expectInvalid(() => codec().decode(fixedVector, extraContext));
    const extraPosition = { ...position, before: selectedTagId };
    expectInvalid(() => codec().encode(context, extraPosition));
  });
});
