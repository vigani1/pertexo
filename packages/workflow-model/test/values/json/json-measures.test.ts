import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  measureBoundedJson,
  snapshotBoundedJson,
  type BoundedJsonSnapshotOptions,
} from '../../../src/values/json/bounded-json-size.js';
import {
  canonicalizeJson,
  inspectJsonValue,
} from '../../../src/values/json/canonical.js';

// Stored values are measured natively and untrusted input by the walk; a value
// must cost the same either way, or a stored value could pass one guard and
// fail the other.
describe('JSON measures', () => {
  it('gives a normalized value the same bytes, depth and members through either measure', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const normalized = canonicalizeJson(value);
        const { bytes, depth, members } = inspectJsonValue(normalized);
        expect(measureBoundedJson(normalized)).toEqual({
          ok: true,
          bytes,
          depth,
          members,
        });
      }),
    );
  });

  it('agrees on text that needs escapes and on characters outside the basic plane', () => {
    const value = {
      'quote"and\\slash': ['line\nbreak', '\u0001', 'é', '😀', ' '],
      nested: { empty: {}, list: [] },
    };
    const { bytes, depth, members } = inspectJsonValue(value);
    expect(measureBoundedJson(canonicalizeJson(value))).toEqual({
      ok: true,
      bytes,
      depth,
      members,
    });
  });

  // Each guard words its own refusal, but one rule prices a value: graph
  // admission and stored values snapshot it, engine guards only measure it.
  const callers: readonly (readonly [string, BoundedJsonSnapshotOptions])[] = [
    ['graph admission', { properties: 'written', depthCounts: 'values' }],
    [
      'stored values',
      { jsonbText: true, nullPrototype: true, refuseObject: () => false },
    ],
  ];
  const nested = (depth: number): unknown => {
    let value: unknown = 'leaf';
    for (let level = 0; level < depth; level += 1)
      value = level % 2 === 0 ? { next: value } : [value];
    return value;
  };
  const representative: readonly (readonly [string, unknown])[] = [
    ['deep nesting', nested(200)],
    ['a large string', 'x'.repeat(262_144)],
    ['non-ASCII text', { clé: ['é', '😀', '漢字', 'Ω≈ç√'], 'emoji😀': '👩‍💻' }],
    ['escapes', ['"', '\\', '\n\t\r\b\f', '\u0001\u001f', '\u007f']],
    ['numbers', [0, -0, 1e21, -1.5e-7, Number.MAX_SAFE_INTEGER, 0.1]],
    ['literals', [null, true, false, {}, [], [[]], { a: {} }]],
  ];
  const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;

  it.each(representative)(
    'prices %s the same through the measure and every snapshot',
    (_, value) => {
      const bytes = utf8(JSON.stringify(value));
      const measured = measureBoundedJson(value);
      expect(measured).toMatchObject({ ok: true, bytes });
      for (const [, options] of callers) {
        const snapshot = snapshotBoundedJson(value, undefined, options);
        expect(snapshot).toMatchObject({ ok: true, bytes });
        if (!snapshot.ok || !measured.ok) continue;
        expect(snapshot.members).toBe(measured.members);
        expect(snapshot.depth).toBe(measured.depth);
        expect(JSON.stringify(snapshot.snapshot)).toBe(JSON.stringify(value));
      }
    },
  );

  it.each(representative)(
    'admits %s at its exact byte cost and refuses it one byte under',
    (_, value) => {
      const bytes = utf8(JSON.stringify(value));
      const at = { bytes, depth: Infinity, members: Infinity };
      const under = { ...at, bytes: bytes - 1 };
      expect(measureBoundedJson(value, at)).toMatchObject({ ok: true });
      expect(measureBoundedJson(value, under)).toEqual({
        ok: false,
        refusal: 'bytes',
      });
      for (const [, options] of callers) {
        expect(snapshotBoundedJson(value, at, options)).toMatchObject({
          ok: true,
        });
        expect(snapshotBoundedJson(value, under, options)).toMatchObject({
          ok: false,
          refusal: 'bytes',
        });
      }
    },
  );

  it('gives any JSON value the same cost through the measure and both snapshots', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const measured = measureBoundedJson(value);
        for (const [, options] of callers)
          expect(snapshotBoundedJson(value, undefined, options)).toMatchObject(
            measured.ok
              ? { ok: true, bytes: measured.bytes, members: measured.members }
              : { ok: false },
          );
      }),
    );
  });
});
