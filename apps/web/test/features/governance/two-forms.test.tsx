import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { PublicationPolicy } from '@/features/governance/components/publication-policy';
import { AuditRetention } from '@/features/governance/components/retention';
import { governanceQueryOptions } from '@/features/governance/data/audit.queries';
import { createApiClient } from '@/lib/api/client';

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') throw new Error('Expected JSON body');
  return JSON.parse(body) as unknown;
}

function setup() {
  let settings = {
    revision: 1,
    auditRetentionDays: 365,
    requirePublishApproval: false,
  };
  let conflict = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    await Promise.resolve();
    if (init?.method === 'PUT') {
      if (conflict) {
        conflict = false;
        return new Response(
          JSON.stringify({
            type: 'urn:pertexo:problem:workspace.conflict',
            title: 'Conflict',
            status: 409,
            code: 'workspace.conflict',
            requestId: 'conflict',
          }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/problem+json' },
          },
        );
      }
      const body = parseBody(init.body) as Partial<typeof settings> & {
        expectedRevision: number;
      };
      settings = {
        ...settings,
        ...('auditRetentionDays' in body
          ? { auditRetentionDays: body.auditRetentionDays }
          : {}),
        ...('requirePublishApproval' in body
          ? { requirePublishApproval: body.requirePublishApproval }
          : {}),
        revision: settings.revision + 1,
      };
    }
    return new Response(JSON.stringify(settings), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const scope = {
    apiClient: createApiClient({
      fetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    }),
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Forms() {
    const query = useQuery(governanceQueryOptions(scope));
    if (!query.data) return null;
    return (
      <>
        <PublicationPolicy scope={scope} snapshot={query.data} editable />
        <AuditRetention scope={scope} snapshot={query.data} editable />
      </>
    );
  }
  render(
    <QueryClientProvider client={client}>
      <Forms />
    </QueryClientProvider>,
  );
  return {
    fetch,
    update: async (next: typeof settings) => {
      settings = next;
      await client.invalidateQueries({
        queryKey: governanceQueryOptions(scope).queryKey,
      });
    },
    conflict: () => {
      conflict = true;
    },
  };
}
const warning = /Someone else changed this setting/;
async function editRetention(value: string) {
  const user = userEvent.setup();
  const input = await screen.findByRole('spinbutton', {
    name: 'Keep audit events (days)',
  });
  await user.clear(input);
  await user.type(input, value);
  return input;
}
it.each(['policy', 'retention'])(
  'saves both forms in %s first order using the latest revision',
  async (first) => {
    const { fetch } = setup();
    const user = userEvent.setup();
    const checkbox = await screen.findByRole('checkbox', {
      name: 'Require approval to publish',
    });
    if (first === 'policy') {
      await user.click(checkbox);
      await user.click(
        screen.getByRole('button', { name: 'Save publishing policy' }),
      );
      await screen.findByText('Publishing policy saved.');
      await editRetention('90');
      await user.click(screen.getByRole('button', { name: 'Save retention' }));
      await screen.findByText('Retention saved.');
    } else {
      await editRetention('90');
      await user.click(screen.getByRole('button', { name: 'Save retention' }));
      await screen.findByText('Retention saved.');
      await user.click(checkbox);
      await user.click(
        screen.getByRole('button', { name: 'Save publishing policy' }),
      );
      await screen.findByText('Publishing policy saved.');
    }
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    const puts = fetch.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(parseBody(puts[1]?.[1]?.body)).toMatchObject({
      expectedRevision: 2,
    });
  },
);
it('keeps a retention edit on a conflicting update until reloaded', async () => {
  const app = setup();
  const user = userEvent.setup();
  const input = await editRetention('90');
  await app.update({
    revision: 2,
    auditRetentionDays: 180,
    requirePublishApproval: false,
  });
  expect(await screen.findByText(warning)).toBeVisible();
  expect(input).toHaveValue(90);
  expect(screen.getByRole('button', { name: 'Save retention' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Reload setting' }));
  expect(input).toHaveValue(180);
  await user.clear(input);
  await user.type(input, '120');
  expect(screen.getByRole('button', { name: 'Save retention' })).toBeEnabled();
});
it('accepts another setting changing and saves against its revision', async () => {
  const app = setup();
  const user = userEvent.setup();
  await editRetention('90');
  await app.update({
    revision: 2,
    auditRetentionDays: 365,
    requirePublishApproval: true,
  });
  expect(screen.queryByText(warning)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save retention' }));
  await screen.findByText('Retention saved.');
  const put = app.fetch.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(parseBody(put?.[1]?.body)).toMatchObject({
    expectedRevision: 2,
    auditRetentionDays: 90,
  });
});
it('refetches settings after a conflict', async () => {
  const app = setup();
  const user = userEvent.setup();
  await editRetention('90');
  app.conflict();
  const gets = () =>
    app.fetch.mock.calls.filter(([, init]) => init?.method !== 'PUT').length;
  const before = gets();
  await user.click(screen.getByRole('button', { name: 'Save retention' }));
  await waitFor(() => {
    expect(gets()).toBeGreaterThan(before);
  });
});

it('warns when the publishing setting changes and reloads it', async () => {
  const app = setup();
  const user = userEvent.setup();
  const checkbox = await screen.findByRole('checkbox', {
    name: 'Require approval to publish',
  });
  await user.click(checkbox);
  await app.update({
    revision: 2,
    auditRetentionDays: 365,
    requirePublishApproval: true,
  });
  expect(await screen.findByText(warning)).toBeVisible();
  expect(checkbox).toBeChecked();
  expect(
    screen.getByRole('button', { name: 'Save publishing policy' }),
  ).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Reload setting' }));
  expect(checkbox).toBeChecked();
  await user.click(checkbox);
  expect(
    screen.getByRole('button', { name: 'Save publishing policy' }),
  ).toBeEnabled();
});
