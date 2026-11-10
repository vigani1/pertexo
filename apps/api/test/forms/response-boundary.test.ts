import { z } from 'zod';
import { responseProjection } from '../../src/workspaces/http/response-projection.js';
import { Controller, Module } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formRoutes } from '@pertexo/contracts/server';
import { Route } from '../../src/workspaces/http/route.js';
import { routeHarness } from '../support/route-harness.js';

const id = '11111111-1111-4111-8111-111111111111';
class ReceiptController {
  submit() {
    return {
      accepted: true,
      thankYouMessage: 'Thanks',
      replayed: false,
      runId: id,
      internalProof: 'private',
    };
  }
  read() {
    return {
      versionId: id,
      form: {
        title: 'Public form',
        instructions: '',
        fields: [
          {
            id: 'name',
            name: 'name',
            label: 'Name',
            type: 'text',
            required: true,
            privateMetadata: 'private',
          },
        ],
        internalProof: 'private',
      },
      internalProof: 'private',
    };
  }
}
// Nest requires a module class for this isolated HTTP contract fixture.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class ReceiptModule {}

Controller()(ReceiptController);
Module({})(ReceiptModule);
for (const [method, route] of [
  ['submit', formRoutes.publicSubmit],
  ['read', formRoutes.publicRead],
] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(
    ReceiptController.prototype,
    method,
  );
  if (descriptor === undefined) throw new Error('Receipt handler missing');
  Route(route)(ReceiptController.prototype, method, descriptor);
}

afterEach(() => vi.unstubAllEnvs());
const headers = {
  'x-pertexo-form-key': 'k'.repeat(43),
  'idempotency-key': 'submit-1',
};
describe('the declared form response boundary', () => {
  it('projects private and undeclared fields once in production while retaining a successful response', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const app = await routeHarness({
      module: ReceiptModule,
      controllers: [ReceiptController],
    });
    try {
      const submitted = await app.send('POST', `/v1/forms/${id}/submit`, {
        headers,
        body: { versionId: id, values: {} },
      });
      expect(submitted.statusCode).toBe(200);
      expect(submitted.json()).toEqual({
        accepted: true,
        thankYouMessage: 'Thanks',
        replayed: false,
      });
      const shown = await app.send('GET', `/v1/forms/${id}`, { headers });
      expect(shown.statusCode).toBe(200);
      expect(shown.payload).not.toContain('private');
      expect(shown.json()).toMatchObject({
        versionId: id,
        form: {
          title: 'Public form',
          fields: [{ type: 'text', name: 'name' }],
        },
      });
      const invalid = await app.send('POST', `/v1/forms/${id}/submit`, {
        headers,
        body: { versionId: id, values: {}, unexpected: true },
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('strips undeclared response fields in tests just as in production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const app = await routeHarness({
      module: ReceiptModule,
      controllers: [ReceiptController],
    });
    try {
      const response = await app.send('POST', `/v1/forms/${id}/submit`, {
        headers,
        body: { versionId: id, values: {} },
      });
      expect(response.statusCode).toBe(200);
      expect(response.payload).not.toContain('private');
      expect(response.json()).toEqual({
        accepted: true,
        thankYouMessage: 'Thanks',
        replayed: false,
      });
    } finally {
      await app.close();
    }
  });
});

it('keeps schema-declared business records and open objects while stripping undeclared response metadata', () => {
  const schema = z
    .object({
      business: z.record(z.string(), z.unknown()),
      open: z.looseObject({ known: z.string() }),
    })
    .strict();
  expect(
    responseProjection(schema).parse({
      business: { artifactId: 'ordinary data' },
      open: { known: 'kept', artifactId: 'also ordinary' },
      privateMetadata: 'strip',
    }),
  ).toEqual({
    business: { artifactId: 'ordinary data' },
    open: { known: 'kept', artifactId: 'also ordinary' },
  });
  expect(
    schema.safeParse({
      business: {},
      open: { known: 'kept' },
      privateMetadata: 'strict in tests',
    }).success,
  ).toBe(false);
});
