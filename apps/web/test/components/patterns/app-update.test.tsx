import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Component, Suspense, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lazyPiece, lazyRoute } from '@/components/patterns/app-update/lazy';
import { AppUpdatedDialog } from '@/components/patterns/app-update/notice';

/** How Chromium rejects an import whose file a deployment removed. */
function goneChunk<T>(): Promise<T> {
  return Promise.reject(
    new TypeError(
      'Failed to fetch dynamically imported module: https://pertexo.test/assets/setup-3f9a1c.js',
    ),
  );
}

let reload: ReturnType<typeof vi.fn>;
beforeEach(() => {
  reload = vi.fn();
  vi.stubGlobal(
    'location',
    Object.assign(new URL(window.location.href), { reload }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A draft the person is typing, which nothing has saved yet. */
function UnsavedDraft() {
  const [draft, setDraft] = useState('');
  return (
    <label>
      Draft
      <textarea
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
      />
    </label>
  );
}

class ErrorBoundary extends Component<
  Readonly<{ children: ReactNode }>,
  { error?: Error }
> {
  public override state: { error?: Error } = {};
  public static getDerivedStateFromError(error: Error) {
    return { error };
  }
  public override render() {
    return this.state.error === undefined ? (
      this.props.children
    ) : (
      <p role="alert">{this.state.error.message}</p>
    );
  }
}

describe('an in-page piece whose chunk is gone', () => {
  it('shows the update notice in its place and keeps the unsaved page around it', async () => {
    const user = userEvent.setup();
    const CodeSetup = lazyPiece(goneChunk<() => ReactNode>);
    function Inspector() {
      const [codeOpen, setCodeOpen] = useState(false);
      return (
        <>
          <UnsavedDraft />
          <button
            type="button"
            onClick={() => {
              setCodeOpen(true);
            }}
          >
            Open Code step
          </button>
          {codeOpen ? (
            <Suspense fallback={<p>Loading JavaScript editor</p>}>
              <CodeSetup />
            </Suspense>
          ) : null}
        </>
      );
    }
    render(<Inspector />);
    const draft = screen.getByRole('textbox', { name: 'Draft' });
    await user.type(draft, 'Unsaved step');
    await user.click(screen.getByRole('button', { name: 'Open Code step' }));

    expect(
      await screen.findByText('Pertexo was updated. Reload to continue.'),
    ).toBeVisible();
    expect(draft).toHaveValue('Unsaved step');
    expect(reload).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('opens a dialog whose chunk is gone as the update dialog, which closes back to the page', async () => {
    const user = userEvent.setup();
    const ExportDialog = lazyPiece(
      goneChunk<(props: Readonly<{ onClose: () => void }>) => ReactNode>,
      AppUpdatedDialog,
    );
    function WorkflowBar() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            Export…
          </button>
          {open ? (
            <Suspense fallback={null}>
              <ExportDialog
                onClose={() => {
                  setOpen(false);
                }}
              />
            </Suspense>
          ) : null}
        </>
      );
    }
    render(<WorkflowBar />);
    await user.click(screen.getByRole('button', { name: 'Export…' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Pertexo was updated',
    });
    expect(within(dialog).getByText('Reload to continue.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Export…' })).toBeVisible();
    expect(reload).not.toHaveBeenCalled();
  });

  it('lets any other failure reach the error boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Broken = lazyPiece((): Promise<() => ReactNode> =>
      Promise.reject(new Error('The setup module threw while loading')),
    );
    render(
      <ErrorBoundary>
        <Suspense fallback={null}>
          <Broken />
        </Suspense>
      </ErrorBoundary>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The setup module threw while loading',
    );
    expect(screen.queryByText(/Pertexo was updated/u)).toBeNull();
  });
});

describe('a route chunk that is gone', () => {
  it('shows the update page where the route goes and never reloads a dirty editor by itself', async () => {
    const user = userEvent.setup();
    // The editor stays mounted around its child routes, like the workflow
    // hub around its tabs, so the failed route lands beside unsaved edits.
    const rootRoute = createRootRoute({
      component: () => (
        <>
          <UnsavedDraft />
          <Outlet />
        </>
      ),
    });
    const buildRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <p>Build</p>,
    });
    const runsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: 'runs',
      component: lazyRoute(
        goneChunk<Readonly<{ RunsRoute: () => ReactNode }>>,
        'RunsRoute',
      ),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([buildRoute, runsRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    render(<RouterProvider router={router} />);
    const draft = await screen.findByRole('textbox', { name: 'Draft' });
    await user.type(draft, 'Unsaved step');

    act(() => {
      router.history.push('/runs');
    });

    expect(
      await screen.findByRole('heading', { name: 'Pertexo was updated' }),
    ).toBeVisible();
    expect(screen.getByText('Reload to continue.')).toBeVisible();
    expect(draft).toHaveValue('Unsaved step');
    expect(router.state.location.pathname).toBe('/runs');
    expect(reload).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledOnce();
  });
});
