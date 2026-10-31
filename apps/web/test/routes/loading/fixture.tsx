import type { AccessibleWorkspace } from '@pertexo/contracts';
import { HttpResponse, http } from 'msw';
import {
  apiBase,
  fixtureIds,
  fixtureWorkspace,
} from '../../support/fixtures/run';
import {
  draftBody,
  editorHandlers,
  emptyGraph,
  etagA,
} from '../../support/fixtures/workflow-editor';
import { mockServer } from '../../support/mock-server';
export const {
  workspace: workspaceId,
  firstRun: runId,
  workflow: workflowId,
} = fixtureIds;

export const readerCapabilities: AccessibleWorkspace['capabilities'] = [
  'workspace:read',
  'run:read',
  'workflow:read',
];

const editorWorkspaceId = '01a0e3bb-aac9-75b8-845e-fa98f0e3e6c5';

export const editorWorkflowId = '01a0e3bb-dca6-725a-9467-b223a018bc1a';

const editorApi = `http://pertexo.test/v1/workspaces/${editorWorkspaceId}/workflows/${editorWorkflowId}`;

export const editorRoute = `/w/${editorWorkspaceId}/workflows/${editorWorkflowId}`;

export function installExistingEditorHandlers(
  draftRead: () => Response | Promise<Response> = () =>
    HttpResponse.json(
      { ...draftBody(emptyGraph, 1), workflowId: editorWorkflowId },
      { headers: { etag: etagA } },
    ),
  connectionsRead: () => Response | Promise<Response> = () =>
    HttpResponse.json({ items: [], nextCursor: null }),
) {
  mockServer.use(...editorHandlers(() => undefined));
  mockServer.use(
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({
        items: [
          {
            ...fixtureWorkspace([
              'workspace:read',
              'workflow:read',
              'workflow:update',
              'connection:read',
            ]),
            id: editorWorkspaceId,
          },
        ],
        nextCursor: null,
      }),
    ),
    http.get(
      `http://pertexo.test/v1/workspaces/${editorWorkspaceId}/connections`,
      connectionsRead,
    ),
    http.get(editorApi, () =>
      HttpResponse.json({
        workflow: {
          id: editorWorkflowId,
          workspaceId: editorWorkspaceId,
          name: 'Owned editor smoke',
          nameRevision: 1,
          lifecycleStatus: 'active',
          lifecycleRevision: 1,
          activationStatus: 'inactive',
          webhookSetupRequired: false,
          publishedVersionId: null,
          createdAt: '2026-09-27T16:38:54.900Z',
          updatedAt: '2026-09-27T16:38:54.882Z',
        },
      }),
    ),
    http.get(`${editorApi}/draft`, draftRead),
  );
}

export function unauthenticated() {
  return HttpResponse.json(
    {
      type: 'urn:pertexo:problem:auth.unauthenticated',
      title: 'Authentication required',
      status: 401,
      code: 'auth.unauthenticated',
      requestId: 'request-signed-out',
    },
    { status: 401, headers: { 'content-type': 'application/problem+json' } },
  );
}

export const signInCapabilities = http.get(
  'http://pertexo.test/v1/auth/capabilities',
  () =>
    HttpResponse.json({
      password: {
        enabled: true,
        minimumLength: 12,
        verificationRequired: true,
      },
      socialProviders: [],
      signUp: 'open',
    }),
);

export const noWorkflows = http.get(`${apiBase}/workflows`, () =>
  HttpResponse.json({ items: [], nextCursor: null }),
);

export function pending() {
  return new Promise<Response>(() => undefined);
}
