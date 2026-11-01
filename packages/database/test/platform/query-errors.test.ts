import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  isTransientDatabaseFailure,
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

describe('isTransientDatabaseFailure', () => {
  const failure = (code?: string, message = 'failed') =>
    Object.assign(new Error(message), code === undefined ? {} : { code });

  it.each([
    ['ECONNREFUSED'],
    ['ECONNRESET'],
    ['57P01'],
    ['57P03'],
    ['08006'],
    ['40001'],
  ])('retries Postgres being unreachable or busy (%s)', (code) => {
    expect(isTransientDatabaseFailure(failure(code))).toBe(true);
  });

  it.each([
    ['Connection terminated unexpectedly'],
    ['timeout exceeded when trying to connect'],
  ])('retries the client losing its connection (%s)', (message) => {
    expect(isTransientDatabaseFailure(failure(undefined, message))).toBe(true);
  });

  it.each([['55P03'], ['40P01'], ['53300']])(
    'retries a statement that only lost out for now (%s)',
    (code) => {
      expect(isTransientDatabaseFailure(failure(code))).toBe(true);
    },
  );

  // What Drizzle really throws: the database failure is its cause.
  it('sees through the query wrapper', () => {
    const wrapped = (cause: Error) =>
      new DrizzleQueryError('update app.node_attempts', [], cause);

    expect(isTransientDatabaseFailure(wrapped(failure('ECONNREFUSED')))).toBe(
      true,
    );
    expect(
      isTransientDatabaseFailure(
        wrapped(failure(undefined, 'Connection terminated unexpectedly')),
      ),
    ).toBe(true);
    expect(isTransientDatabaseFailure(wrapped(failure('23505')))).toBe(false);
  });

  it.each([
    ['canceling statement due to statement timeout', '57014'],
    ['Query read timeout', undefined],
  ])('retries a statement that ran out of time (%s)', (message, code) => {
    expect(isTransientDatabaseFailure(failure(code, message))).toBe(true);
  });

  it.each([['23505'], ['42601'], ['42501']])(
    'never retries a statement that was refused (%s)',
    (code) => {
      expect(isTransientDatabaseFailure(failure(code))).toBe(false);
    },
  );

  it('calls a failure and its failed rollback transient only when both are', () => {
    const lost = failure('57P01');
    const rollback = failure(undefined, 'Connection terminated unexpectedly');
    expect(
      isTransientDatabaseFailure(new AggregateError([lost, rollback])),
    ).toBe(true);
    expect(
      isTransientDatabaseFailure(
        new AggregateError([new Error('a bug'), rollback]),
      ),
    ).toBe(false);
    expect(isTransientDatabaseFailure(new AggregateError([]))).toBe(false);
  });

  it('never retries an ordinary error or a thrown value', () => {
    expect(isTransientDatabaseFailure(new Error('stale lease'))).toBe(false);
    expect(isTransientDatabaseFailure('nope')).toBe(false);
  });
});
