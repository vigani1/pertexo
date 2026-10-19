import { describe, expect, it } from 'vitest';

import {
  csrfTokenSchema,
  webhookContentTypeSchema,
} from '../src/schemas/shared/transport-headers.js';
import { idempotencyKeySchema } from '../src/schemas/identity/workspaces.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
} from '../src/openapi/primitives.js';
import { webhooksOpenApiDocument } from '../src/server.js';

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

  it('documents the webhook body media types and their UTF-8 charset', () => {
    for (const value of [
      'application/json',
      'Application/JSON',
      'application/json; charset=utf-8',
      'APPLICATION/JSON ; CHARSET=UTF-8',
      'application/cloudevents+json',
      'application/x-www-form-urlencoded; charset=UTF-8',
      'text/plain',
      'text/plain; charset="utf-8"',
    ])
      expect(webhookContentTypeSchema.safeParse(value).success).toBe(true);
    for (const value of [
      'application/jsonevil',
      'application/+json',
      'application/json; charset=latin1',
      'application/json; profile=test',
      'text/html',
      'multipart/form-data; boundary=x',
    ])
      expect(webhookContentTypeSchema.safeParse(value).success).toBe(false);

    const hook = webhooksOpenApiDocument.paths['/hooks/{endpointKey}'];
    expect(Object.keys(hook.post.requestBody.content)).toEqual([
      'application/json',
      'application/x-www-form-urlencoded',
      'text/plain',
    ]);
    expect(hook.post.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Content-Type',
          in: 'header',
          required: false,
        }),
      ]),
    );
    expect(hook.get.responses).toHaveProperty('405');
  });
});
