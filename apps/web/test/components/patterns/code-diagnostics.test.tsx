import { NotificationsProvider } from '@/components/ui/toast';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CodeDiagnostics } from '@/components/patterns/code/diagnostics';

describe('private Code diagnostics', () => {
  it('shows console messages and positioned errors as literal user text', () => {
    const { container } = render(
      <CodeDiagnostics
        diagnostics={{
          logs: [{ level: 'warn', message: '<img src=x onerror=alert(1)>' }],
          truncated: true,
          error: {
            message: '<script>private failure</script>',
            line: 2,
            column: 4,
          },
        }}
      />,
      { wrapper: NotificationsProvider },
    );
    expect(screen.getByLabelText('Code console output')).toHaveTextContent(
      '[warn] <img src=x onerror=alert(1)>',
    );
    expect(screen.getByText('<script>private failure</script>')).toBeVisible();
    expect(screen.getByText('Line 2, column 4')).toBeVisible();
    expect(screen.getByText(/Console output was truncated/u)).toBeVisible();
    expect(container.querySelector('img, script')).toBeNull();
  });
  it('explains an attempt with no console messages', () => {
    render(<CodeDiagnostics diagnostics={{ logs: [], truncated: false }} />, {
      wrapper: NotificationsProvider,
    });
    expect(screen.getByText('No console output.')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Copy console output' }),
    ).not.toBeInTheDocument();
  });
});
