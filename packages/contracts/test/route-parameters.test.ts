import { responseSchema } from '../src/schemas/shared/response-schema.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineRoute, named } from '../src/routes/define.js';
import { routePaths } from '../src/routes/openapi.js';
import { foldersRoutes } from '../src/routes/workflows/folders.js';

const fields = [
  ['enum', z.enum(['member', 'group'])],
  ['literal', z.literal('member')],
  ['ordinary string', z.string().min(1)],
  ['nullable required', z.string().nullable()],
  ['optional', z.string().optional()],
  ['exact optional', z.string().exactOptional()],
  ['default', z.enum(['member', 'group']).default('member')],
] as const;

describe.each(['query', 'headers'] as const)(
  '%s operation projection',
  (location) => {
    it.each(fields)('agrees with input omission for %s', (_name, field) => {
      const input = z.object({ selection: field });
      const route = defineRoute({
        operationId: 'selectPrincipals',
        method: 'get',
        path: '/principals',
        access: { auth: 'public' },
        rateLimit: 'authenticated_read',
        [location]: input,
        success: {
          status: 200,
          description: 'Principals',
          body: named('Principals', responseSchema(z.array(z.string()))),
        },
        problems: {},
      });
      const parameter = routePaths([route])['/principals'].get.parameters.find(
        ({ name }) => name === 'selection',
      );
      expect(parameter).toBeDefined();
      expect(parameter?.in).toBe(location === 'headers' ? 'header' : 'query');
      expect(parameter?.required).toBe(!input.safeParse({}).success);
    });
  },
);

it('publishes sharing-principal kind as required where the real route requires it', () => {
  const route = foldersRoutes.sharingPrincipals;
  expect(route.query.safeParse({}).success).toBe(false);
  const operation = routePaths([route])[route.path].get;
  expect(
    operation.parameters.find(({ name }) => name === 'kind'),
  ).toMatchObject({ in: 'query', required: true });
});
