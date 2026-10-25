import { screen, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../../support/fixtures/identity';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const destinationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const timestamp = '2026-09-15T10:00:00.000Z';

export const destinationsUrl = `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`;

const user = createUserFixture({
  id: userId,
  email: 'owner@example.test',
  displayName: 'Workspace Owner',
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const workspace = createWorkspaceFixture({
  id: workspaceId,
  capabilities: [
    'workspace:read',
    'workflow:update',
    'connection:read',
    'connection:manage',
  ],
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const connection = {
  id: connectionId,
  workspaceId,
  providerKey: 'slack',
  name: 'Incident Slack',
  authType: 'slack_bot_token',
  status: 'active',
  secretVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
  createdAt: timestamp,
  updatedAt: timestamp,
};

export function destination(
  channelId = 'C0123456789',
  currentVersion = 1,
  status: 'enabled' | 'disabled' = 'enabled',
) {
  return {
    id: destinationId,
    workspaceId,
    kind: 'slack',
    status,
    currentVersion,
    config: { kind: 'slack', connectionId, channelId },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function identityHandlers(currentWorkspace: unknown = workspace) {
  return [
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [currentWorkspace], nextCursor: null }),
    ),
  ];
}

export function connectionHandler() {
  return http.get(
    `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
    () => HttpResponse.json({ items: [connection], nextCursor: null }),
  );
}

export function destinationsOf(
  items: () => readonly ReturnType<typeof destination>[],
) {
  return http.get(destinationsUrl, () => HttpResponse.json({ items: items() }));
}

export function problem(status: number, code: string) {
  return HttpResponse.json(
    {
      type: `urn:pertexo:problem:${code}`,
      title: 'Problem',
      status,
      code,
      requestId: `request-${code}`,
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

export function lens() {
  const sheet = document.querySelector<HTMLElement>(
    '[data-slot="sheet-content"]',
  );
  if (sheet === null) throw new Error('No lens is open.');
  return within(sheet);
}

export async function chooseConnection(
  actor: ReturnType<typeof userEvent.setup>,
) {
  await actor.click(lens().getByLabelText('Slack connection'));
  await actor.click(
    await screen.findByRole('option', { name: 'Incident Slack' }),
  );
}
