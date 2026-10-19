import { describe, expect, it } from 'vitest';
import {
  fieldLabel,
  toShownValue,
  unitDisplay,
} from '@/features/workflow-editor/model/field-units';
import {
  parseNumberField,
  schemaFields,
  schemaPropertyCount,
} from '@/features/workflow-editor/model/inspector/draft';

describe('step setup fields', () => {
  it('reads catalog settings in people’s words and units', () => {
    const [timeout, response, wait, url] = schemaFields({
      type: 'object',
      properties: {
        timeoutMillis: { type: 'integer', minimum: 1, maximum: 30_000 },
        maxResponseBytes: { type: 'integer', maximum: 10_485_760 },
        durationSeconds: { type: 'integer', maximum: 2_592_000 },
        url: { type: 'string' },
      },
    });
    if (
      timeout === undefined ||
      response === undefined ||
      wait === undefined ||
      url === undefined
    )
      throw new Error('expected four schema fields');
    expect(timeout).toMatchObject({ label: 'Timeout', unit: 'milliseconds' });
    expect(response).toMatchObject({
      label: 'Largest response',
      unit: 'bytes',
    });
    expect(wait).toMatchObject({ label: 'Wait for', unit: 'seconds' });
    expect(url).toMatchObject({ label: 'URL' });
    expect(url).not.toHaveProperty('unit');
    expect(fieldLabel('retryAfterSeconds')).toBe('Retry after');
    expect(fieldLabel('api_key_id')).toBe('API key ID');

    // Milliseconds are typed as seconds.
    expect(parseNumberField(timeout, '2.5')).toEqual({ ok: true, value: 2500 });
    expect(parseNumberField(timeout, '0.0005')).toEqual({
      ok: false,
      error: 'Timeout can have at most 3 decimals.',
    });
    expect(parseNumberField(timeout, '31')).toEqual({
      ok: false,
      error: 'Timeout can be at most 30 s.',
    });
    expect(parseNumberField(response, '11')).toEqual({
      ok: false,
      error: 'Largest response can be at most 10 MB.',
    });
    expect(parseNumberField(wait, '2592001')).toEqual({
      ok: false,
      error: 'Wait for can be at most 30 days.',
    });
  });

  it.each([
    { maximum: 10_485_760, bytes: 1_048_576, shown: 1 },
    { maximum: 10_485_760, bytes: 1_153_434, shown: 1.1 },
    { maximum: 10_485_760, bytes: 1_048_577, shown: 1.000001 },
    { maximum: 262_144, bytes: 65_536, shown: 64 },
    { maximum: 262_144, bytes: 65_537, shown: 64.001 },
    { maximum: 1_023, bytes: 513, shown: 513 },
  ])(
    'round-trips $bytes bytes through the size field',
    ({ maximum, bytes, shown }) => {
      const field = {
        key: 'sizeBytes',
        label: 'Size',
        kind: 'integer',
        required: true,
        unit: 'bytes',
        minimum: 1,
        maximum,
      } as const;
      expect(toShownValue(bytes, field.unit, maximum)).toBe(shown);
      expect(parseNumberField(field, String(shown))).toEqual({
        ok: true,
        value: bytes,
      });
    },
  );

  it('keeps size units tied to the bound and reports bounds in human units', () => {
    expect(unitDisplay('bytes', 10_485_760)).toMatchObject({
      symbol: 'MB',
      name: 'megabytes',
    });
    expect(unitDisplay('bytes', 262_144)).toMatchObject({
      symbol: 'KB',
      name: 'kilobytes',
    });
    expect(unitDisplay('bytes', 1_023)).toMatchObject({
      symbol: 'B',
      name: 'bytes',
    });
    const field = {
      key: 'sizeBytes',
      label: 'Size',
      kind: 'integer',
      required: true,
      unit: 'bytes',
      minimum: 1,
      maximum: 262_144,
    } as const;
    expect(parseNumberField(field, '1.5')).toEqual({ ok: true, value: 1_536 });
    expect(parseNumberField(field, '257')).toEqual({
      ok: false,
      error: 'Size can be at most 256 KB.',
    });
    expect(parseNumberField(field, '0')).toEqual({
      ok: false,
      error: 'Size must be at least 1 B.',
    });
  });
});

it('counts the settings of a setup that takes one of several shapes', () => {
  expect(schemaPropertyCount({ type: 'object', properties: { a: {} } })).toBe(
    1,
  );
  // Date chooses an operation; each choice brings its own settings.
  expect(
    schemaPropertyCount({
      oneOf: [
        { type: 'object', properties: { operation: {} } },
        { type: 'object', properties: { operation: {}, timeZone: {} } },
      ],
    }),
  ).toBe(3);
  expect(schemaPropertyCount({ type: 'object' })).toBe(0);
  expect(schemaPropertyCount(null)).toBe(0);
});
