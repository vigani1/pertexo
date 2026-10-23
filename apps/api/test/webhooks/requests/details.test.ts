import { expect, it } from 'vitest';
import { searchFields } from '../../../src/webhooks/requests/details.js';

it('keeps scalar fields and repeated values in wire order', () => {
  expect(
    searchFields('name=first&name=second&single=value&constructor=ordinary'),
  ).toEqual({
    name: ['first', 'second'],
    single: 'value',
    constructor: 'ordinary',
  });
});

it('decodes 60,000 repeated fields within the ingress byte budget without blocking for seconds', () => {
  const body = Array<string>(60_000).fill('a=1').join('&');
  expect(Buffer.byteLength(body)).toBeLessThan(256 * 1024);
  const started = performance.now();
  const parsed = searchFields(body);
  const elapsed = performance.now() - started;
  expect(parsed.a).toEqual(Array<string>(60_000).fill('1'));
  expect(elapsed).toBeLessThan(1_000);
});
