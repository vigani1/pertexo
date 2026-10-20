import { describe, expect, it } from 'vitest';
import { noteTextStart } from '@/features/workflow-drafts/public';

describe('plain note excerpts', () => {
  it('reads headings, emphasis, links and code without markup or destinations', () => {
    expect(
      noteTextStart(
        '## **Orders**\n\nKeep _one_ [record](https://example.test) and `amount`.',
      ),
    ).toBe('Orders Keep one record and amount.');
  });
  it('leaves literal punctuation intact and ignores images and HTML tags', () => {
    expect(
      noteTextStart('2 * 3 and snake_case. ![secret](https://image.test) <br>'),
    ).toBe('2 * 3 and snake_case.');
  });
  it('bounds excerpts and tolerates maximally nested note formatting', () => {
    expect(noteTextStart('x'.repeat(4000))).toHaveLength(80);
    expect(noteTextStart('> '.repeat(1900) + '**Deep**')).toBe('Deep');
  });
});
