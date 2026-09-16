import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../src/app/query-client';
import { cn } from '../src/lib/utils';

describe('frontend foundation', () => {
  it('creates isolated server caches and does not retry writes', () => {
    const first = createQueryClient();
    const second = createQueryClient();
    first.setQueryData(['test'], 'first session');
    expect(second.getQueryData(['test'])).toBeUndefined();
    expect(first.getDefaultOptions().mutations?.retry).toBe(false);
    first.clear();
    second.clear();
  });

  it('merges conditional Tailwind classes predictably', () => {
    expect(cn('px-2', false, 'px-4')).toBe('px-4');
  });
});
