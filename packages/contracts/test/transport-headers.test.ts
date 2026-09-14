import { describe, expect, it } from 'vitest';

import {
  csrfTokenSchema,
  webhookJsonContentTypeSchema,
} from '../src/http/transport-headers.js';
import { idempotencyKeySchema } from '../src/http/identity-workspace.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
} from '../src/openapi-primitives.js';
import { webhooksOpenApiDocument } from '../src/webhooks.js';

describe('transport header contracts', () => {
  it('keeps CSRF and idempotency runtime bounds aligned with parameters', () => {
    for (const value of ['x'.repeat(16), 'x'.repeat(256)])
      expect(csrfTokenSchema.safeParse(value).success).toBe(true);
    for (const value of ['x'.repeat(15), 'x'.repeat(257)])
      expect(csrfTokenSchema.safeParse(value).success).toBe(false);
    for (const value of ['!', '~'.repeat(128)])
      expect(idempotencyKeySchema.safeParse(value).success).toBe(true);
    for (const value of ['', 'has space', 'one,two', 'x'.repeat(129)])
      expect(idempotencyKeySchema.safeParse(value).success).toBe(false);

    expect(csrfHeaderParameter().schema).toEqual(
      expect.objectContaining({ minLength: 16, maxLength: 256 }),
    );
    const idempotencySchema = idempotencyHeaderParameter().schema as Readonly<
      Record<string, unknown>
    >;
    expect(idempotencySchema).toEqual(
      expect.objectContaining({ minLength: 1, maxLength: 128 }),
    );
    const pattern = new RegExp(String(idempotencySchema.pattern), 'u');
    expect(pattern.test('one-two')).toBe(true);
    expect(pattern.test('one,two')).toBe(false);
  });

  it('documents runtime webhook charset restrictions separately from OpenAPI media type', () => {
    for (const value of [
      'application/json',
      'Application/JSON',
      'application/json; charset=utf-8',
      'APPLICATION/JSON ; CHARSET=UTF-8',
    ])
      expect(webhookJsonContentTypeSchema.safeParse(value).success).toBe(true);
    for (const value of [
      'application/jsonevil',
      'application/json; charset=latin1',
      'application/json; profile=test',
    ])
      expect(webhookJsonContentTypeSchema.safeParse(value).success).toBe(false);

    const operation =
      webhooksOpenApiDocument.paths['/hooks/{endpointKey}'].post;
    expect(operation.requestBody.content).toHaveProperty('application/json');
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Content-Type',
          in: 'header',
          required: true,
        }),
      ]),
    );
  });
});
