import { describe, expect, it } from 'vitest';

import {
  parseStrongIfMatch,
  WorkflowHeaderError,
} from '../../../src/workflow-authoring/http/preconditions.js';

const tag = '"draft-v1.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"';

describe('workflow authoring HTTP preconditions', () => {
  it.each([
    { name: 'missing', value: undefined },
    { name: 'an empty header array', value: [] },
    { name: 'a singleton non-string array', value: [42] },
  ])('classifies $name If-Match as missing', ({ value }) => {
    expectHeaderFailure(
      () => parseStrongIfMatch(value),
      'precondition_required',
      'If-Match is required',
    );
  });

  it.each([
    { name: 'empty', value: '' },
    { name: 'multiple header values', value: [tag, tag] },
    { name: 'a non-string value', value: 42 },
    { name: 'weak', value: `W/${tag}` },
    { name: 'wildcard', value: '*' },
    { name: 'comma-combined', value: `${tag}, ${tag}` },
    { name: 'unquoted', value: 'draft-v1.missing-quotes' },
    { name: 'wrong-length', value: '"draft-v1.short"' },
  ])('classifies $name If-Match as malformed', ({ value }) => {
    expectHeaderFailure(
      () => parseStrongIfMatch(value),
      'invalid',
      'If-Match must contain exactly one valid value',
    );
  });

  it('accepts exactly one generated strong tag in scalar and array form', () => {
    expect(parseStrongIfMatch(tag)).toBe(tag);
    expect(parseStrongIfMatch([tag])).toBe(tag);
  });
});

function expectHeaderFailure(
  work: () => unknown,
  code: WorkflowHeaderError['code'],
  message: string,
): void {
  try {
    work();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WorkflowHeaderError);
    expect(error).toMatchObject({ code, message, name: 'WorkflowHeaderError' });
    return;
  }
  throw new Error('Expected workflow header parsing to fail');
}
