import { expect, it } from 'vitest';
import { cn } from '@/lib/class-names';

it('keeps a type-scale size beside a text colour and lets a later size win', () => {
  expect(cn('text-label', 'text-muted-foreground')).toBe(
    'text-label text-muted-foreground',
  );
  expect(cn('text-caption text-subtle-foreground', 'text-label')).toBe(
    'text-subtle-foreground text-label',
  );
  expect(cn('text-sm', 'text-display')).toBe('text-display');
});
