import { describe, expect, it } from 'vitest';
import { nestsTooDeeply } from '@/features/workflow-editor/model/notes/formatting';

describe('note nesting depth before parsing', () => {
  it.each([
    ['33 quotes on one line', `${'>'.repeat(33)} x`, true],
    ['33 spaced quotes', `${'> '.repeat(33)}x`, true],
    ['33 nested list markers', `${'  - '.repeat(33)}x`, true],
    ['33 nested numbered items', `${'1. '.repeat(33)}x`, true],
    ['32 quotes', `${'>'.repeat(32)} x`, false],
    ['ordinary formatting', '# Orders\n\n> Verified\n\n- Capture', false],
    ['a rule of dashes', '-'.repeat(200), false],
  ])('%s', (_kind, text, expected) => {
    expect(nestsTooDeeply(text)).toBe(expected);
  });
});
