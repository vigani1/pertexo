import { describe, expect, it } from 'vitest';
import { fieldLabel } from '@/features/workflow-editor/model/field-units';
import {
  parseNumberField,
  schemaFields,
} from '@/features/workflow-editor/model/inspector-draft';

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
    expect(parseNumberField(response, '20000000')).toEqual({
      ok: false,
      error: 'Largest response can be at most 10 MB.',
    });
    expect(parseNumberField(wait, '2592001')).toEqual({
      ok: false,
      error: 'Wait for can be at most 30 days.',
    });
  });
});
