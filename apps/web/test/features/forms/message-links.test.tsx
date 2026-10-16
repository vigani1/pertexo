import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ThankYouMessage } from '@/features/forms/components/thank-you';
import { formMessageParts } from '@/features/forms/model/message-links';

it('turns plain HTTP(S) destinations into safe links while preserving punctuation and text', () => {
  const message =
    'Thanks! Read https://example.test/docs. Also (https://example.test/a_(b)).';
  expect(
    formMessageParts(message)
      .map(({ text }) => text)
      .join(''),
  ).toBe(message);
  render(<ThankYouMessage message={message} />);
  expect(
    screen.getAllByRole('link').map((link) => link.getAttribute('href')),
  ).toEqual(['https://example.test/docs', 'https://example.test/a_(b)']);
  expect(screen.getAllByRole('link')[0]).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  expect(screen.getAllByRole('link')[0]).toHaveAttribute(
    'referrerpolicy',
    'no-referrer',
  );
});
it('never renders markup or executable/credential-bearing URLs', () => {
  const message =
    '<img src=x onerror=alert(1)> javascript:alert(1) data:text/html,bad https://user:pass@example.test/';
  const result = render(<ThankYouMessage message={message} />);
  expect(result.container.textContent).toBe(message);
  expect(result.container.querySelector('img')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
});
