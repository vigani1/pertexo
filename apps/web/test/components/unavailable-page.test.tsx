import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UnavailablePage } from '../../src/components/patterns/unavailable-page';

describe('UnavailablePage', () => {
  it('keeps the page heading and says why the page can’t be used', () => {
    render(
      <UnavailablePage
        heading="Connections"
        title="Connections are unavailable"
        description="Your role can’t see this workspace’s connections."
      />,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Connections' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Connections are unavailable',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Your role can’t see this workspace’s connections.'),
    ).toBeInTheDocument();
  });
});
