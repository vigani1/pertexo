import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../../support/fixtures/identity';
import { mockServer } from '../../../support/mock-server';
export const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const existingWorkspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const createdWorkspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const timestamp = '2026-09-21T10:00:00.000Z';

export const csrfToken = 'csrf-token-for-component-tests-12345678901234567890';

export const user = createUserFixture({
  id: userId,
  email: 'owner@example.test',
  displayName: 'Workspace Owner',
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const existingWorkspace = accessibleWorkspace(
  existingWorkspaceId,
  'Existing Operations',
  'existing-operations',
);

export const createdWorkspace = accessibleWorkspace(
  createdWorkspaceId,
  'Signal Operations',
  'signal-operations',
);

function accessibleWorkspace(id: string, name: string, slug: string) {
  return createWorkspaceFixture({
    id,
    name,
    slug,
    capabilities: [
      'workspace:read',
      'workspace:manage',
      'workflow:read',
      'workflow:create',
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function workspaceResponse() {
  return {
    id: createdWorkspace.id,
    name: createdWorkspace.name,
    slug: createdWorkspace.slug,
    status: createdWorkspace.status,
    createdAt: createdWorkspace.createdAt,
    updatedAt: createdWorkspace.updatedAt,
  };
}

export function problem(status: number, code: string, title: string) {
  return HttpResponse.json(
    {
      type: `https://pertexo.test/problems/${code}`,
      title,
      status,
      code,
      requestId: 'workspace-create-test',
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

export function installWorkspaceDestination() {
  mockServer.use(
    http.get(
      `http://pertexo.test/v1/workspaces/${createdWorkspaceId}/workflows`,
      () => HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('http://pertexo.test/v1/node-definitions', () =>
      HttpResponse.json({
        items: [],
      }),
    ),
    http.get('http://pertexo.test/v1/integrations', () =>
      HttpResponse.json({
        items: [],
      }),
    ),
    http.get(
      `http://pertexo.test/v1/workspaces/${createdWorkspaceId}/connections`,
      () => HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
}

export function installIdentity(workspaces: readonly object[] = []) {
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: workspaces, nextCursor: null }),
    ),
  );
}

export async function openCreation(kind: 'first' | 'another') {
  if (kind === 'first')
    return screen.findByRole('region', { name: 'Create your workspace' });
  await userEvent
    .setup()
    .click(await screen.findByRole('button', { name: 'New workspace' }));
  return screen.findByRole('dialog', { name: 'New workspace' });
}

export async function revealHandle(form: HTMLElement) {
  await userEvent
    .setup()
    .click(within(form).getByRole('button', { name: 'Edit handle' }));
  return within(form).getByLabelText('Handle');
}
