import { NotificationsProvider } from '@/components/ui/toast';
import { WebhookTestEventPanel } from '@/features/workflow-publish/components/webhook-test-events/panel';
import type { ApiClient, ApiJsonRequest } from '@/lib/api/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
const id = '11111111-1111-4111-8111-111111111111';
const limits = { inlineBytes: 262144, depth: 64, members: 10000 };
function fixture() {
  const requests: ApiJsonRequest<unknown>[] = [];
  let state = 'waiting';
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const apiClient =
    /* Vitest models the overloaded request method as its last signature; this recorder exercises only the declared test responses. */ {
      request: (input: ApiJsonRequest<unknown>) =>
        Promise.resolve().then(() => {
          requests.push(input);
          if (input.path.endsWith('/sample')) {
            if (input.method === 'PUT')
              return { sampleId: id, removed: false, replayed: false };
            return { sample: null, output: null, draftRevision: 3, limits };
          }
          if (input.method === 'POST')
            return {
              id,
              path: `/hooks/${'a'.repeat(43)}/test`,
              expiresAt: new Date(Date.now() + 120000).toISOString(),
              signingSecret: 'b'.repeat(43),
              authentication:
                input.body === undefined
                  ? {}
                  : (input.body as { authentication: unknown }).authentication,
            };
          if (input.method === 'DELETE') return undefined;
          return {
            state,
            expiresAt: new Date(Date.now() + 120000).toISOString(),
            output:
              state === 'captured'
                ? { kind: 'inline', value: { amount: 17 } }
                : null,
          };
        }),
      stream: vi.fn(),
    } as unknown as ApiClient;
  const scope = {
    apiClient,
    userId: 'owner',
    workspaceId: 'workspace',
    workflowId: 'workflow',
  };
  const ensureSaved = vi.fn(() => Promise.resolve({ revision: 3 }));
  const view = (binding = 'binding') => (
    <QueryClientProvider client={client}>
      <NotificationsProvider>
        <WebhookTestEventPanel
          scope={scope}
          nodeId="webhook"
          binding={binding}
          ensureSaved={ensureSaved}
        />
      </NotificationsProvider>
    </QueryClientProvider>
  );
  return {
    requests,
    client,
    ensureSaved,
    view,
    setState: (next: string) => {
      state = next;
    },
  };
}
const scroll = vi.fn();
const originalScroll = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);
beforeAll(() =>
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scroll,
  }),
);
afterAll(() => {
  if (originalScroll === undefined)
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  else
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollIntoView',
      originalScroll,
    );
});
describe('webhook test capture', () => {
  it('captures without executing and only pins after an explicit review', async () => {
    const f = fixture();
    render(f.view());
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Listen for test event' }),
    );
    await screen.findByText('Listening for one request…');
    expect(
      screen.getByRole('heading', { name: 'Receive a real sample' }),
    ).toHaveFocus();
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
    expect(f.ensureSaved).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(
        f.client
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.data),
      ),
    ).not.toContain('b'.repeat(43));
    expect(
      f.requests.find((request) => request.method === 'POST')?.body,
    ).toEqual({
      expectedDraftRevision: 3,
      authentication: { mode: 'signed', allowedOrigins: [] },
    });
    expect(f.requests.some((request) => request.path.endsWith('/test'))).toBe(
      false,
    );
    f.setState('captured');
    await act(() => f.client.invalidateQueries());
    await screen.findByText('Test event received');
    expect(
      f.requests.filter((request) => request.method === 'PUT'),
    ).toHaveLength(0);
    await user.click(
      screen.getByRole('button', { name: 'Keep as pinned sample' }),
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Check it for secrets first');
    await user.click(
      within(dialog).getByRole('button', { name: 'Keep as pinned sample' }),
    );
    await screen.findByText('Kept as pinned sample');
    expect(
      f.requests.find((request) => request.method === 'PUT')?.body,
    ).toEqual({
      expectedDraftRevision: 3,
      expectedSampleId: null,
      source: { kind: 'webhook_test', listenerId: id },
    });
  });
  it('stops listening on close and suppresses captures when the local setup changes', async () => {
    const f = fixture();
    const view = render(f.view());
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Listen for test event' }),
    );
    await screen.findByText('Listening for one request…');
    view.rerender(f.view('different'));
    expect(screen.getByText('Step changed — listen again')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Keep as pinned sample' }),
    ).toBeNull();
    view.unmount();
    await waitFor(() => {
      expect(f.requests.some((request) => request.method === 'DELETE')).toBe(
        true,
      );
    });
  });
  it('uses secret URL explicitly and explains its credential tradeoff', async () => {
    const f = fixture();
    render(f.view());
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Test authentication'));
    await user.click(await screen.findByRole('option', { name: 'Secret URL' }));
    expect(
      screen.getByText(
        'Anyone with the test URL can send the sample. Keep it private.',
      ),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Listen for test event' }),
    );
    await screen.findByText('Listening for one request…');
    expect(
      f.requests.find((request) => request.method === 'POST')?.body,
    ).toEqual({
      expectedDraftRevision: 3,
      authentication: { mode: 'secret_url', allowedOrigins: [] },
    });
  });
  it('keeps the chosen authentication and non-secret fields after stopping', async () => {
    const f = fixture();
    render(f.view());
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Test authentication'));
    await user.click(
      await screen.findByRole('option', { name: 'Header secret' }),
    );
    await user.clear(screen.getByLabelText('Secret header'));
    await user.type(screen.getByLabelText('Secret header'), 'x-test-secret');
    await user.type(
      screen.getByLabelText('Allowed browser origins (optional)'),
      'https://example.test',
    );
    await user.click(
      screen.getByRole('button', { name: 'Listen for test event' }),
    );
    await screen.findByText('Listening for one request…');
    await user.click(screen.getByRole('button', { name: 'Stop listening' }));
    await screen.findByRole('button', { name: 'Listen for test event' });
    expect(screen.getByLabelText('Test authentication')).toHaveTextContent(
      'Header secret',
    );
    expect(screen.getByLabelText('Secret header')).toHaveValue('x-test-secret');
    expect(
      screen.getByLabelText('Allowed browser origins (optional)'),
    ).toHaveValue('https://example.test');
    await user.click(
      screen.getByRole('button', { name: 'Listen for test event' }),
    );
    await screen.findByText('Listening for one request…');
    expect(
      f.requests.filter((request) => request.method === 'POST').at(-1)?.body,
    ).toMatchObject({
      authentication: {
        mode: 'header_secret',
        headerName: 'x-test-secret',
        allowedOrigins: ['https://example.test'],
      },
    });
  });
  it('expires visibly and never offers to pin a changed server capture', async () => {
    const f = fixture();
    render(f.view());
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Listen for test event' }),
    );
    await screen.findByText('Listening for one request…');
    f.setState('changed');
    await act(() => f.client.invalidateQueries());
    await screen.findByText('Step changed — listen again');
    expect(
      screen.queryByRole('button', { name: 'Keep as pinned sample' }),
    ).toBeNull();
  });
});
