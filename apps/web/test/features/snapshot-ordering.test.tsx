import { useState } from 'react';
import { user as currentUser } from './workflows/list/fixtures';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { useConnectionSharingEditor } from '@/features/connections/hooks/use-sharing-editor';
import { useFolderSharingEditor } from '@/features/workflows/hooks/use-folder-sharing';
import { useFederationCommand } from '@/features/federation/data/federation-command.mutations';
import { federationSettingsQueryOptions } from '@/features/federation/data/federation-settings.queries';
import { createApiClient } from '@/lib/api/client';
import {
  json,
  settings,
  organization,
  userId,
  workspaceId,
} from './federation/fixtures';
const resourceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

it.each(['connection', 'folder'] as const)(
  'confirms %s sharing from a read started after acceptance',
  async (kind) => {
    let release: (() => void) | undefined;
    let releaseConfirmation: (() => void) | undefined;
    let reads = 0;
    let saved = false;
    let changedAgain = false;
    const original =
      kind === 'connection'
        ? {
            connectionId: resourceId,
            revision: 1,
            mode: 'workspace',
            members: [],
          }
        : {
            folderId: resourceId,
            revision: 1,
            mode: 'workspace',
            grants: [],
            labels: {},
          };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (typeof _url === 'string' && _url.endsWith('/users/me'))
        return json(currentUser);
      if (init?.method === 'POST') {
        saved = true;
        return json({
          ...original,
          mode: 'restricted',
          revision: 2,
          replayed: false,
        });
      }
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return json(original);
      }
      if (reads === 3)
        await new Promise<void>((resolve) => {
          releaseConfirmation = resolve;
        });
      if (changedAgain) return json({ ...original, revision: 3 });
      return json(
        saved ? { ...original, mode: 'restricted', revision: 2 } : original,
      );
    });
    const scope = {
      apiClient: createApiClient({
        fetch,
        readCsrfToken: () => 'csrf-token-1234567890',
      }),
      userId,
      workspaceId,
    };
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    function Connection() {
      const [confirmed, setConfirmed] = useState(false);
      const editor = useConnectionSharingEditor(scope, resourceId, () => {
        setConfirmed(true);
      });
      return (
        <>
          <p>{editor.command.error}</p>
          {confirmed ? <p>Sharing confirmed</p> : null}
          <output>
            {editor.snapshot?.mode}:{editor.snapshot?.revision}
          </output>
          <button
            onClick={() => {
              editor.update((value) => ({ ...value, mode: 'restricted' }));
            }}
          >
            Edit
          </button>
          <button
            onClick={() => {
              void editor.submit();
            }}
          >
            Save
          </button>
        </>
      );
    }
    function Folder() {
      const [confirmed, setConfirmed] = useState(false);
      const editor = useFolderSharingEditor(scope, resourceId, () => {
        setConfirmed(true);
      });
      return (
        <>
          <p>{editor.command.error}</p>
          {confirmed ? <p>Sharing confirmed</p> : null}
          <output>
            {editor.snapshot?.mode}:{editor.snapshot?.revision}
          </output>
          <button
            onClick={() => {
              editor.update((value) => ({ ...value, mode: 'restricted' }));
            }}
          >
            Edit
          </button>
          <button
            onClick={() => {
              void editor.submit();
            }}
          >
            Save
          </button>
        </>
      );
    }
    render(
      <QueryClientProvider client={cache}>
        {kind === 'connection' ? <Connection /> : <Folder />}
      </QueryClientProvider>,
    );
    await screen.findByText('workspace:1');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    let reading: Promise<void> | undefined;
    act(() => {
      reading = cache.refetchQueries();
    });
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(saved).toBe(true);
    });
    await act(async () => {
      release?.();
      await reading;
    });
    await waitFor(() => {
      expect(releaseConfirmation).toBeDefined();
    });
    expect(screen.queryByText('Sharing confirmed')).not.toBeInTheDocument();
    act(() => {
      releaseConfirmation?.();
    });
    await screen.findByText('restricted:2');
    await screen.findByText('Sharing confirmed');
    changedAgain = true;
    await act(async () => {
      await cache.refetchQueries();
    });
    expect(await screen.findByText('workspace:3')).toBeVisible();
    cache.clear();
  },
);

it('keeps accepted federation settings visible when an older settings read finishes later', async () => {
  let release: (() => void) | undefined;
  let reads = 0;
  const accepted = {
    ...settings,
    organization: {
      ...organization,
      revision: 2,
      name: 'Accepted organization',
    },
  };
  let changedAgain = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (init?.method === 'POST') return json(accepted);
    reads += 1;
    if (reads === 2)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return json(
      changedAgain
        ? {
            ...accepted,
            organization: {
              ...accepted.organization,
              revision: 3,
              name: 'Changed again on server',
            },
          }
        : settings,
    );
  });
  const scope = {
    apiClient: createApiClient({
      fetch,
      readCsrfToken: () => 'csrf-token-1234567890',
    }),
    userId,
    workspaceId,
  };
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Settings() {
    const reader = useQuery(federationSettingsQueryOptions(scope));
    const command = useFederationCommand(scope);
    return (
      <>
        <output>{reader.data?.organization?.name}</output>
        <button
          onClick={() => {
            void command.send({
              kind: 'linkWorkspace',
              input: {
                workspaceId,
                defaultRole: 'viewer',
                expectedRevision: 1,
              },
            });
          }}
        >
          Save
        </button>
      </>
    );
  }
  render(
    <QueryClientProvider client={cache}>
      <Settings />
    </QueryClientProvider>,
  );
  await screen.findByText('Example organization');
  let reading: Promise<void> | undefined;
  act(() => {
    reading = cache.refetchQueries();
  });
  await waitFor(() => {
    expect(reads).toBe(2);
  });
  await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Accepted organization');
  await act(async () => {
    release?.();
    await reading;
  });
  expect(
    cache.getQueryData(federationSettingsQueryOptions(scope).queryKey),
  ).toEqual(accepted);
  expect(screen.getByText('Accepted organization')).toBeVisible();
  changedAgain = true;
  await act(async () => {
    await cache.refetchQueries();
  });
  expect(await screen.findByText('Changed again on server')).toBeVisible();
  cache.clear();
});
