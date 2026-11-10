import { responseSchema } from '@pertexo/contracts/server';
import { Controller } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AnyRoute } from '@pertexo/contracts/server';
import { Route, In } from '../../src/workspaces/http/route.js';
import { routeHarness } from '../support/route-harness.js';

const declaration = {
  operationId: 'qualifiedDeclaration',
  method: 'post',
  path: '/qualified/{itemId}',
  access: { auth: 'public' },
  rateLimit: 'ordinary_mutation',
  params: z.object({ itemId: z.uuid() }),
  query: z.object({ limit: z.coerce.number().int().min(1).max(10) }),
  body: {
    name: 'QualifiedInput',
    schema: z
      .object({ nested: z.object({ 'a/b~c': z.string().min(1) }) })
      .strict(),
  },
  success: {
    status: 201,
    description: 'Qualified result',
    body: {
      name: 'QualifiedOutput',
      schema: responseSchema(
        z.object({ id: z.uuid(), limit: z.number(), value: z.string() }),
      ),
    },
  },
  problems: {},
} satisfies AnyRoute;
class QualifiedController {
  answer(input: {
    params: { itemId: string };
    query: { limit: number };
    body: { nested: { 'a/b~c': string } };
  }) {
    return input.body.nested['a/b~c'] === 'break-response'
      ? { private: 'private-response-canary' }
      : {
          id: input.params.itemId,
          limit: input.query.limit,
          value: input.body.nested['a/b~c'],
        };
  }
}
Controller()(QualifiedController);
const descriptor = Object.getOwnPropertyDescriptor(
  QualifiedController.prototype,
  'answer',
);
if (descriptor === undefined) throw new Error('Fixture handler missing');
Route(declaration)(QualifiedController.prototype, 'answer', descriptor);
In()(QualifiedController.prototype, 'answer', 0);
// Nest requires a class token for a test module.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class QualifiedModule {}
let harness: Awaited<ReturnType<typeof routeHarness>>;
beforeAll(async () => {
  harness = await routeHarness({
    module: QualifiedModule,
    controllers: [QualifiedController],
  });
});
afterAll(() => harness.close());
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('declaration-owned transport behavior', () => {
  it('passes parsed and coerced input through @In and checks the declared success', async () => {
    const reply = await harness.send('POST', `/qualified/${id}?limit=3`, {
      body: { nested: { 'a/b~c': 'value' } },
    });
    expect(reply.statusCode, reply.payload).toBe(201);
    expect(reply.json()).toEqual({ id, limit: 3, value: 'value' });
  });
  it('escapes JSON Pointer segments for nested input failures', async () => {
    const reply = await harness.send('POST', `/qualified/${id}?limit=3`, {
      body: { nested: { 'a/b~c': '' } },
    });
    expect(reply.statusCode, reply.payload).toBe(400);
    expect(reply.json()).toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ path: '/nested/a~1b~0c' }),
      ]) as unknown,
    });
  });
  it('returns 500 without input errors or private output when its response violates the schema', async () => {
    const reply = await harness.send('POST', `/qualified/${id}?limit=3`, {
      body: { nested: { 'a/b~c': 'break-response' } },
    });
    expect(reply.statusCode, reply.payload).toBe(500);
    expect(reply.json()).not.toHaveProperty('errors');
    expect(reply.payload).not.toContain('private-response-canary');
  });
});
