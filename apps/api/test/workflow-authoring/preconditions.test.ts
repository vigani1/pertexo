import { describe, expect, it } from 'vitest';

import {
  parseIdempotencyKey,
  parseStrongIfMatch,
  WorkflowHeaderError,
} from '../../src/workflow-authoring/preconditions.js';

describe('workflow authoring HTTP preconditions', () => {
  it('requires exactly one If-Match value', () => {
    expect(() => parseStrongIfMatch(undefined)).toThrow(WorkflowHeaderError);
    expect(() => parseStrongIfMatch([])).toThrow(WorkflowHeaderError);
    expect(() =>
      parseStrongIfMatch(['"draft-v1.abc"', '"draft-v1.def"']),
    ).toThrow();
  });

  it('accepts one generated strong tag and rejects weak, wildcard, lists, and malformed tags', () => {
    const tag = '"draft-v1.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"';
    expect(parseStrongIfMatch(tag)).toBe(tag);
    expect(parseStrongIfMatch([tag])).toBe(tag);
    for (const candidate of [
      `W/${tag}`,
      '*',
      `${tag}, "draft-v1.other"`,
      'draft-v1.missing-quotes',
      '"draft-v1.short"',
    ]) {
      expect(() => parseStrongIfMatch(candidate)).toThrow();
    }
  });

  it('parses printable idempotency keys as one header value', () => {
    expect(parseIdempotencyKey('create-42')).toBe('create-42');
    expect(parseIdempotencyKey(['publish-42'])).toBe('publish-42');
    for (const candidate of [
      undefined,
      [],
      ['one', 'two'],
      'one,two',
      'contains\nnewline',
    ]) {
      expect(() => parseIdempotencyKey(candidate)).toThrow();
    }
  });
});
