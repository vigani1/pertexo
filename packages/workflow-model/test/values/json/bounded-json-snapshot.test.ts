import { describe, expect, it } from 'vitest';
import { snapshotBoundedJson } from '../../../src/values/json/bounded-json-size.js';

const unbounded = { bytes: Infinity, depth: Infinity, members: Infinity };

describe('bounded JSON snapshot', () => {
  it('copies a value into frozen containers that no longer follow the original', () => {
    const value = { list: [1, { name: 'a' }], empty: {} };
    const snapshot = snapshotBoundedJson(value);
    expect(snapshot).toMatchObject({ ok: true, snapshot: value });
    if (!snapshot.ok) return;
    const copy = snapshot.snapshot as typeof value;
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.list)).toBe(true);
    expect(Object.isFrozen(copy.list[1])).toBe(true);
    value.list.push(2);
    expect(copy.list).toHaveLength(2);
  });

  it('writes -0 as 0 and can copy objects without a prototype', () => {
    const snapshot = snapshotBoundedJson({ zero: -0 }, unbounded, {
      nullPrototype: true,
    });
    if (!snapshot.ok) throw new Error('expected a snapshot');
    const copy = snapshot.snapshot as { zero: number };
    expect(Object.is(copy.zero, 0)).toBe(true);
    expect(Object.getPrototypeOf(copy)).toBeNull();
  });

  it('refuses accessors without running them, and says where they are', () => {
    let reads = 0;
    const value = {
      items: [
        Object.defineProperty({}, 'secret', {
          enumerable: true,
          get: () => (reads += 1),
        }),
      ],
    };
    expect(snapshotBoundedJson(value)).toEqual({
      ok: false,
      refusal: 'accessor',
      path: ['items', 0, 'secret'],
    });
    expect(reads).toBe(0);
  });

  it('refuses symbol keys and, read exactly, what JSON would leave out', () => {
    expect(snapshotBoundedJson({ [Symbol('key')]: 1 })).toMatchObject({
      refusal: 'symbol_key',
    });
    const hidden = Object.defineProperty({ shown: 1 }, 'hidden', {
      enumerable: false,
      value: 2,
    });
    const named = Object.assign([1], { name: 'x' });
    expect(snapshotBoundedJson(hidden)).toMatchObject({
      refusal: 'hidden_property',
    });
    expect(snapshotBoundedJson(named)).toMatchObject({
      refusal: 'array_extra_keys',
    });
  });

  it('skips, read as written, what JSON.stringify leaves out', () => {
    const hidden = Object.defineProperty({ shown: 1 }, 'hidden', {
      enumerable: false,
      value: 2,
    });
    const named = Object.assign([1], { name: 'x' });
    for (const value of [hidden, named]) {
      const snapshot = snapshotBoundedJson(value, unbounded, {
        properties: 'written',
      });
      expect(snapshot).toMatchObject({ ok: true });
      if (snapshot.ok)
        expect(JSON.stringify(snapshot.snapshot)).toBe(JSON.stringify(value));
    }
    // eslint-disable-next-line no-sparse-arrays -- the value under test
    const sparse = [1, , 3];
    expect(
      snapshotBoundedJson(sparse, unbounded, { properties: 'written' }),
    ).toEqual({ ok: false, refusal: 'sparse_array', path: [1] });
  });

  it('refuses text jsonb cannot store when asked, in values and keys', () => {
    for (const value of ['nul\u0000', 'lone\ud800', { 'key\u0000': 1 }]) {
      expect(snapshotBoundedJson(value)).toMatchObject({ ok: true });
      expect(
        snapshotBoundedJson(value, unbounded, { jsonbText: true }),
      ).toMatchObject({ ok: false, refusal: 'unstorable_text' });
    }
  });

  it('bounds container nesting, or every value when the depth counts values', () => {
    const value = { a: { b: 'leaf' } };
    const bounds = { ...unbounded, depth: 2 };
    expect(snapshotBoundedJson(value, bounds)).toMatchObject({ ok: true });
    expect(
      snapshotBoundedJson(value, bounds, { depthCounts: 'values' }),
    ).toEqual({ ok: false, refusal: 'depth', path: ['a', 'b'] });
    expect(
      snapshotBoundedJson(
        value,
        { ...bounds, depth: 3 },
        {
          depthCounts: 'values',
        },
      ),
    ).toMatchObject({ ok: true });
  });

  it('admits non-finite numbers only when asked, priced as null', () => {
    expect(snapshotBoundedJson([Number.NaN])).toMatchObject({
      refusal: 'not_json',
    });
    expect(
      snapshotBoundedJson([Number.NaN, Infinity], unbounded, {
        allowNonFiniteNumbers: true,
      }),
    ).toMatchObject({ ok: true, bytes: '[null,null]'.length });
  });

  it('refuses objects the host recognises before reading them', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(
      snapshotBoundedJson({ value: revoked.proxy }, unbounded, {
        refuseObject: (value) => value === revoked.proxy,
      }),
    ).toEqual({ ok: false, refusal: 'not_plain', path: ['value'] });
  });
});
