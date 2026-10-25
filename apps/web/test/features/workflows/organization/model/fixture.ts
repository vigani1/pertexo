import { createApiClient } from '../../../../../src/lib/api/client';
import {
  secondWorkflowId,
  summary,
  workflowId,
  workspaceId,
} from '../../list/fixtures';
export const signal = () => new AbortController().signal;

export const commandScope = {
  workspaceId,
  idempotencyKey: 'individual-command',
};

export const folder = {
  id: secondWorkflowId,
  name: 'Ops',
  parentId: null,
  revision: 2,
  depth: 1,
};

export const tag = { id: secondWorkflowId, key: 'ops', revision: 1 };

export const organization = {
  tags: [tag],
  organizationRevision: 1,
  folderId: null,
  isFavorite: true,
};

export const projection = {
  workflow: summary(workflowId, 'Operations'),
  organization,
};

export const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });

export function client(fetch: typeof globalThis.fetch) {
  return createApiClient({
    fetch,
    readCsrfToken: () => 'csrf-token-1234567890',
  });
}

export function requestUrl(input: RequestInfo | URL | undefined) {
  if (input === undefined) throw new Error('Missing request');
  return input instanceof Request ? input.url : input.toString();
}
