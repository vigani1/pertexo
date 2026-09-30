import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SocialProviderButton } from '@/features/auth/components/social/social-provider-button';
import type { SocialProvider } from '@/features/auth/model/social-provider';

describe('SocialProviderButton', () => {
  it('keeps provider marks decorative and provider actions accessible', () => {
    const providers: readonly SocialProvider[] = [
      'google',
      'microsoft',
      'github',
      'apple',
    ];

    render(
      <div>
        {providers.map((provider) => (
          <SocialProviderButton
            key={provider}
            provider={provider}
            onClick={vi.fn()}
          />
        ))}
      </div>,
    );

    for (const name of ['Google', 'Microsoft', 'GitHub', 'Apple']) {
      const button = screen.getByRole('button', {
        name: `Continue with ${name}`,
      });
      expect(button).toBeVisible();
      expect(within(button).getByText(name)).toBeVisible();
      expect(button.querySelector('svg')).toHaveAttribute(
        'aria-hidden',
        'true',
      );
    }
  });
});
