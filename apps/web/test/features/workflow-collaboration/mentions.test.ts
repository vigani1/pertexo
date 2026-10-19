import { expect, it } from 'vitest';
import {
  insertMention,
  typedMention,
} from '@/features/workflow-collaboration/model/mentions';

it('reads the @name being typed just before the caret', () => {
  expect(typedMention('Hi @ad', 6)).toEqual({ start: 3, query: 'ad' });
  expect(typedMention('@', 1)).toEqual({ start: 0, query: '' });
  // An address or a finished mention isn't a mention being typed.
  expect(typedMention('mail me@example.com', 19)).toBeUndefined();
  expect(typedMention('Hi @ada and', 11)).toBeUndefined();
});

it('writes the chosen name where the @name was typed', () => {
  const text = 'Hi @ad, thanks';
  expect(insertMention(text, { start: 3, query: 'ad' }, 6, 'Ada')).toEqual({
    text: 'Hi @Ada , thanks',
    caret: 8,
  });
});
