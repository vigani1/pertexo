import { QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { NotificationsProvider } from '@/components/ui/toast';
import { FormAccessControl } from '@/features/forms/components/form-access';
import { createApiClient } from '@/lib/api/client';
import { createQueryClient } from '@/app/query-client';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
const id = '11111111-1111-4111-8111-111111111111';
const path = `http://pertexo.test/v1/workspaces/${id}/workflows/${id}/form/access`;
const capability = 'a'.repeat(43);
function mount(editable = true) {
  const apiClient = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  const route = createRootRoute({
    component: () => (
      <FormAccessControl
        scope={{ apiClient, userId: id, workspaceId: id, workflowId: id }}
        editable={editable}
      />
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <NotificationsProvider>
        <RouterProvider router={router} />
      </NotificationsProvider>
    </QueryClientProvider>,
  );
}
it('shows an existing link with copy and QR after reopening', async () => {
  mockServer.use(
    http.get(path, () =>
      HttpResponse.json({
        access: 'public',
        publicId: id,
        revision: 2,
        capability,
      }),
    ),
  );
  const view = mount();
  expect(await screen.findByLabelText('Public form link')).toHaveValue(
    `${window.location.origin}/forms/${id}#${capability}`,
  );
  expect(screen.getByRole('button', { name: 'Copy form link' })).toBeVisible();
  expect(
    screen.getByRole('img', { name: 'Public form QR code' }),
  ).toBeVisible();
  view.unmount();
  mount();
  expect(await screen.findByLabelText('Public form link')).toHaveValue(
    `${window.location.origin}/forms/${id}#${capability}`,
  );
});
it('explains a legacy link and confirms the consequence before regenerating', async () => {
  let token: string | null = null;
  let writes = 0;
  mockServer.use(
    http.get(path, () =>
      HttpResponse.json({
        access: 'public',
        publicId: id,
        revision: writes + 1,
        capability: token,
      }),
    ),
    http.post(path, async ({ request }) => {
      const body = (await request.json()) as { capability: string };
      token = body.capability;
      writes++;
      return HttpResponse.json({
        access: 'public',
        publicId: id,
        revision: writes + 1,
      });
    }),
  );
  mount();
  expect(
    await screen.findByText(/This older link can’t be shown again/u),
  ).toBeVisible();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Regenerate link' }));
  expect(screen.getByRole('dialog')).toHaveTextContent(/pages and QR codes/u);
  expect(writes).toBe(0);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(writes).toBe(0);
  await user.click(screen.getByRole('button', { name: 'Regenerate link' }));
  await user.click(
    screen.getByRole('button', { name: 'Regenerate and invalidate old link' }),
  );
  await waitFor(() => {
    expect(writes).toBe(1);
  });
  expect(token).not.toBeNull();
  expect(await screen.findByLabelText('Public form link')).toHaveValue(
    `${window.location.origin}/forms/${id}#${String(token)}`,
  );
});
it('keeps sharing material and controls away from viewers', async () => {
  mount(false);
  expect(
    await screen.findByText(/An editor manages public access/u),
  ).toBeVisible();
  expect(screen.queryByLabelText('Public form link')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /Regenerate/u }),
  ).not.toBeInTheDocument();
});
it('keeps retry reachable after a confirmed regeneration loses its acknowledgement', async () => {
  let token = capability;
  const writes: { body: unknown; key: string | null }[] = [];
  mockServer.use(
    http.get(path, () =>
      HttpResponse.json({
        access: 'public',
        publicId: id,
        revision: writes.length === 0 ? 1 : 2,
        capability: token,
      }),
    ),
    http.post(path, async ({ request }) => {
      const body = (await request.json()) as { capability: string };
      writes.push({ body, key: request.headers.get('idempotency-key') });
      token = body.capability;
      if (writes.length === 1) return HttpResponse.error();
      return HttpResponse.json({ access: 'public', publicId: id, revision: 2 });
    }),
  );
  mount();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'Regenerate link' }),
  );
  await user.click(
    screen.getByRole('button', { name: 'Regenerate and invalidate old link' }),
  );
  expect(
    await screen.findByRole('button', { name: 'Retry same change' }),
  ).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Retry same change' }));
  await waitFor(() => {
    expect(writes).toHaveLength(2);
  });
  expect(writes[1]).toEqual(writes[0]);
  expect(await screen.findByLabelText('Public form link')).toHaveValue(
    `${window.location.origin}/forms/${id}#${token}`,
  );
});
