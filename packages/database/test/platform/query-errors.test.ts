import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  isUniqueConstraintFailure,
  postgresFailure,
} from '../../src/platform/query-errors.js';

const unique = Object.assign(new Error('duplicate key'), {
  code: '23505',
  constraint: 'connections_active_name_provider_unique',
  detail: 'Key already exists',
});

describe('postgresFailure', () => {
  it('reads the fields a rule branches on, directly or through Drizzle', () => {
    const fields = {
      code: '23505',
      constraint: 'connections_active_name_provider_unique',
      detail: 'Key already exists',
    };
    expect(postgresFailure(unique)).toEqual(fields);
    expect(
      postgresFailure(new DrizzleQueryError('select 1', [], unique)),
    ).toEqual(fields);
  });

  it.each([
    ['a plain error', new Error('nope')],
    ['a non-string code', { code: 23505 }],
    ['null', null],
    ['a string', '23505'],
  ])('finds no fields on %s', (_name, value) => {
    expect(postgresFailure(value)).toEqual({});
    expect(isUniqueConstraintFailure(value)).toBe(false);
  });

  it('recognizes a unique violation through Drizzle', () => {
    expect(
      isUniqueConstraintFailure(new DrizzleQueryError('select 1', [], unique)),
    ).toBe(true);
  });
});
