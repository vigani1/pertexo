import { within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../../support/fixtures/identity';
import type { renderApp } from '../../../support/render-app';
export const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const secretVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export const base = `http://pertexo.test/v1/workspaces/${workspaceId}/connections`;

const user = createUserFixture({
  id: userId,
  email: 'owner@example.test',
  displayName: 'Workspace Owner',
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
});

export const workspace = createWorkspaceFixture({
  id: workspaceId,
  capabilities: [
    'workspace:read',
    'workflow:read',
    'connection:read',
    'connection:use',
    'connection:manage',
  ],
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
});

export type Provider = 'slack' | 'http' | 'email';

const authTypes = {
  slack: 'slack_bot_token',
  http: 'http_headers',
  email: 'resend_api_key',
} as const;

export function connection(
  name: string,
  overrides: Readonly<Record<string, unknown>> & {
    providerKey?: Provider;
  } = {},
) {
  const providerKey = overrides.providerKey ?? 'slack';
  return {
    id: connectionId,
    workspaceId,
    providerKey,
    name,
    authType: authTypes[providerKey],
    status: 'active',
    secretVersionId,
    health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
    createdAt: '2026-09-15T10:00:00.000Z',
    updatedAt: '2026-09-15T10:00:00.000Z',
    ...overrides,
  };
}

export function identityHandlers(
  currentWorkspace: unknown = workspace,
  emptyUsage = true,
) {
  return [
    ...(emptyUsage
      ? [
          http.get(`${base}/${connectionId}/usage`, () =>
            HttpResponse.json({ items: [], nextCursor: null }),
          ),
        ]
      : []),
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [currentWorkspace], nextCursor: null }),
    ),
  ];
}

export function listOf(items: () => readonly unknown[]) {
  return http.get(base, () =>
    HttpResponse.json({ items: items(), nextCursor: null }),
  );
}

export function detailOf(current: () => ReturnType<typeof connection>) {
  return http.get(`${base}/${connectionId}`, () =>
    HttpResponse.json(current()),
  );
}

export function testedOk(current: ReturnType<typeof connection>) {
  return HttpResponse.json({
    connection: current,
    outcome: { ok: true, httpStatus: 200, errorCode: null },
  });
}

export function mutationVariables(
  queryClient: ReturnType<typeof renderApp>['queryClient'],
) {
  return JSON.stringify(
    queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.variables),
  );
}

export function lens() {
  const sheet = document.querySelector<HTMLElement>(
    '[data-slot="sheet-content"]',
  );
  if (sheet === null) throw new Error('No lens is open.');
  return within(sheet);
}
