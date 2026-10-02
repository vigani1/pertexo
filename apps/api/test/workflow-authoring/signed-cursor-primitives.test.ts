import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { InvalidWorkflowCursorError } from '../../src/workflow-authoring/cursor.js';
import {
  assertSignedCursorLifetime,
  createSignedCursorByteEnvelope,
  currentSignedCursorSeconds,
  SIGNED_CURSOR_MAX_UNIX_SECONDS,
} from '../../src/workflow-authoring/signed-cursor-primitives.js';

const key = new Uint8Array(32).fill(7);
const invalidKeyMessage = 'Invalid test-owned signing key';

describe('low-level signed cursor byte and clock primitives', () => {
  it('authenticates arbitrary bytes without owning semantic JSON parsing', () => {
    const envelope = createSignedCursorByteEnvelope(key, invalidKeyMessage);
    const bytes = Buffer.from([255, 0, 123]);
    const wire = envelope.encode(bytes);
    expect(envelope.authenticate(wire)).toEqual(bytes);
    expect(wire).toBe(
      `${bytes.toString('base64url')}.${createHmac('sha256', key).update(bytes).digest('base64url')}`,
    );
    expect(Object.isFrozen(envelope)).toBe(true);
  });

  it('keeps key material private and copies caller-owned root bytes', () => {
    const supplied = Uint8Array.from(key);
    const envelope = createSignedCursorByteEnvelope(
      supplied,
      invalidKeyMessage,
    );
    const bytes = Buffer.from('fixed bytes');
    const before = envelope.encode(bytes);
    supplied.fill(255);
    expect(envelope.encode(bytes)).toBe(before);
  });

  it('derives only an explicitly requested domain subkey without mutating inputs', () => {
    const supplied = Uint8Array.from(key);
    const label = 'test.cursor.key.v1';
    const envelope = createSignedCursorByteEnvelope(
      supplied,
      invalidKeyMessage,
      label,
    );
    const bytes = Buffer.from('fixed bytes');
    const derived = createHmac('sha256', key).update(label, 'utf8').digest();
    expect(envelope.encode(bytes)).toBe(
      `${bytes.toString('base64url')}.${createHmac('sha256', derived).update(bytes).digest('base64url')}`,
    );
    expect(supplied).toEqual(key);
    const rootEnvelope = createSignedCursorByteEnvelope(key, invalidKeyMessage);
    expect(() => rootEnvelope.authenticate(envelope.encode(bytes))).toThrow(
      InvalidWorkflowCursorError,
    );
  });

  it.each([0, 31, 33])(
    'preserves configured constructor errors for %i-byte keys',
    (length) => {
      expect(() =>
        createSignedCursorByteEnvelope(
          new Uint8Array(length),
          invalidKeyMessage,
        ),
      ).toThrow(invalidKeyMessage);
    },
  );

  it('permits exactly 512 ASCII wire bytes and rejects overflow in both directions', () => {
    const envelope = createSignedCursorByteEnvelope(key, invalidKeyMessage);
    const maximum = new Uint8Array(351).fill(7);
    const wire = envelope.encode(maximum);
    expect(wire.length).toBe(512);
    expect(envelope.authenticate(wire)).toEqual(Buffer.from(maximum));
    expect(() => envelope.encode(new Uint8Array(352))).toThrow(
      InvalidWorkflowCursorError,
    );
    expect(() => envelope.authenticate(`${wire}A`)).toThrow(
      InvalidWorkflowCursorError,
    );
  });

  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029', '='])(
    'rejects noncanonical suffix %#',
    (suffix) => {
      const envelope = createSignedCursorByteEnvelope(key, invalidKeyMessage);
      const wire = envelope.encode(Buffer.from('fixed bytes'));
      expect(() => envelope.authenticate(`${wire}${suffix}`)).toThrow(
        InvalidWorkflowCursorError,
      );
      expect(() =>
        envelope.authenticate(wire.replace('.', `${suffix}.`)),
      ).toThrow(InvalidWorkflowCursorError);
    },
  );

  it('rejects malformed, tampered, noncanonical-bit and wrong-size signatures', () => {
    const envelope = createSignedCursorByteEnvelope(key, invalidKeyMessage);
    const wire = envelope.encode(Buffer.from('fixed bytes'));
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(wire.slice(-1));
    const noncanonical = `${wire.slice(0, -1)}${alphabet[last + 1] ?? ''}`;
    for (const bad of [
      '',
      'not-a-wire',
      `${wire}.extra`,
      `${wire.slice(0, -2)}AA`,
      wire.slice(0, -1),
      noncanonical,
    ]) {
      expect(() => envelope.authenticate(bad)).toThrow(
        InvalidWorkflowCursorError,
      );
    }
  });

  it('floors valid millisecond clocks including exact range endpoints', () => {
    expect(currentSignedCursorSeconds(() => 0)).toBe(0);
    expect(currentSignedCursorSeconds(() => 1999)).toBe(1);
    expect(
      currentSignedCursorSeconds(
        () => SIGNED_CURSOR_MAX_UNIX_SECONDS * 1000 + 999,
      ),
    ).toBe(SIGNED_CURSOR_MAX_UNIX_SECONDS);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    'rejects invalid millisecond clock %s',
    (time) => {
      expect(() => currentSignedCursorSeconds(() => time)).toThrow(
        InvalidWorkflowCursorError,
      );
    },
  );

  it('checks exact lifetime, exclusive expiry and future issuance separately from semantic scope', () => {
    expect(() => {
      assertSignedCursorLifetime(100, 1000, 999, 900);
    }).not.toThrow();
    for (const [issued, expires, current] of [
      [100, 1000, 1000],
      [100, 1000, 99],
      [100, 1001, 100],
    ]) {
      expect(() => {
        assertSignedCursorLifetime(
          issued ?? 0,
          expires ?? 0,
          current ?? 0,
          900,
        );
      }).toThrow(InvalidWorkflowCursorError);
    }
  });
});
