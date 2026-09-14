import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FoundationPage } from '../src/routes/foundation-page';
import { createQueryClient } from '../src/app/query-client';
import { cn } from '../src/lib/utils';

describe('frontend foundation', () => {
  it('supports the local interaction through the keyboard', async () => {
    const user = userEvent.setup();
    render(<FoundationPage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'The foundation is ready.',
    );
    await user.tab();
    expect(
      screen.getByRole('button', { name: 'Test interaction' }),
    ).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('status')).toHaveTextContent('Interaction works.');
    await user.click(screen.getByRole('button', { name: 'Reset check' }));
    expect(screen.getByRole('status')).toHaveTextContent('Ready when you are.');
  });

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
