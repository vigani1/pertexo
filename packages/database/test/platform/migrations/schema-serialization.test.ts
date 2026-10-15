import { expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { PgDialect } from 'drizzle-orm/pg-core';
import { apiTokens } from '../../../src/schema/identity/api-tokens.js';

it('generates the token scope constraint when the migration tool extends Array.prototype', () => {
  const prior = Object.getOwnPropertyDescriptor(Array.prototype, 'random');
  Object.defineProperty(Array.prototype, 'random', {
    configurable: true,
    enumerable: true,
    value: () => undefined,
  });
  try {
    const constraint = getTableConfig(apiTokens).checks.find(
      ({ name }) => name === 'api_tokens_scopes_valid',
    );
    expect(constraint).toBeDefined();
    if (constraint === undefined) throw new Error('Scope constraint missing');
    expect(new PgDialect().sqlToQuery(constraint.value).sql).toContain(
      `'["workflow:read","workflow:create","workflow:publish","run:read","run:start","run:cancel","connection:read"]'::jsonb`,
    );
  } finally {
    if (prior === undefined) Reflect.deleteProperty(Array.prototype, 'random');
    else Object.defineProperty(Array.prototype, 'random', prior);
  }
});
