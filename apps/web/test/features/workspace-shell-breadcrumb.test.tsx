import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ShellBreadcrumb } from '@/features/workspaces/components/shell/shell-breadcrumb';

const crumbs = [
  { key: 'runs', label: <a href="/runs">Runs</a> },
  { key: 'workflow', label: <a href="/workflows/1">Invoice intake</a> },
  { key: 'run', label: <span className="font-mono">7f3a…4c21</span> },
];

describe('the shell breadcrumb', () => {
  it('folds the steps between the workspace and the page into “…” on narrow screens', async () => {
    render(
      <ShellBreadcrumb
        root={<button type="button">Northwind Ops</button>}
        crumbs={crumbs}
      />,
    );
    const trail = within(
      screen.getByRole('navigation', { name: 'Breadcrumb' }),
    );
    const items = trail.getAllByRole('listitem');
    // The page's crumb is last and never folds.
    expect(items.at(-1)).toHaveAttribute('aria-current', 'page');
    expect(items.at(-1)).toHaveTextContent('7f3a…4c21');
    expect(items.at(-1)).not.toHaveClass('hidden');
    // Wide screens show every step; narrow ones show the fold instead.
    expect(trail.getByRole('link', { name: 'Runs' }).closest('li')).toHaveClass(
      'hidden',
      'sm:flex',
    );
    const fold = trail.getByRole('button', {
      name: 'Show 2 more steps of the path',
    });
    expect(fold.closest('li')).toHaveClass('sm:hidden');

    await userEvent.setup().click(fold);
    const lens = await screen.findByRole('dialog', {
      name: 'The path to this page',
    });
    expect(
      within(lens)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Runs', 'Invoice intake']);
  });

  it('has nothing to fold with one step after the workspace', () => {
    render(
      <ShellBreadcrumb
        root={<button type="button">Northwind Ops</button>}
        crumbs={[{ key: 'team', label: 'Team' }]}
      />,
    );
    expect(screen.queryByRole('button', { name: /more steps?/u })).toBeNull();
    expect(screen.getByText('Team').closest('li')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
