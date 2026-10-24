import {
  directorySettingsSchema,
  directoryPeoplePageSchema,
  directoryAdoptionPreviewSchema,
  directoryCredentialResultSchema,
  directoryChangedSchema,
  type DirectoryMappings,
  type DirectoryAdopt,
  type DirectoryPeopleQuery,
  type DirectoryAdoptionQuery,
} from '@pertexo/contracts';
import type { FederationScope } from './settings.api';

const base = (scope: FederationScope): `/v1${string}` =>
  `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/sso/directory`;
export function readDirectory(scope: FederationScope, signal: AbortSignal) {
  return scope.apiClient.request({
    path: base(scope),
    signal,
    response: {
      kind: 'json',
      decode: (value) => directorySettingsSchema.parse(value),
    },
  });
}
export function readDirectoryPeople(
  scope: FederationScope,
  query: DirectoryPeopleQuery,
  signal: AbortSignal,
) {
  const search = new URLSearchParams({
    limit: String(query.limit),
    ...(query.search === undefined ? {} : { search: query.search }),
    ...(query.after === undefined ? {} : { after: query.after }),
  });
  return scope.apiClient.request({
    path: `${base(scope)}/people?${search}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => directoryPeoplePageSchema.parse(value),
    },
  });
}
export function readAdoptionPreview(
  scope: FederationScope,
  query: DirectoryAdoptionQuery,
  signal: AbortSignal,
) {
  const search = new URLSearchParams(query);
  return scope.apiClient.request({
    path: `${base(scope)}/adoption?${search}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => directoryAdoptionPreviewSchema.parse(value),
    },
  });
}
export function createDirectoryCredential(
  scope: FederationScope,
  input: Readonly<{ name: string; expectedRevision: number }>,
  key: string,
  signal: AbortSignal,
) {
  return scope.apiClient.request({
    path: `${base(scope)}/credentials`,
    method: 'POST',
    body: input,
    headers: { 'Idempotency-Key': key },
    signal,
    response: {
      kind: 'json',
      decode: (value) => directoryCredentialResultSchema.parse(value),
    },
  });
}
export type DirectoryCommand =
  | Readonly<{
      kind: 'revoke';
      credentialId: string;
      input: { expectedRevision: number };
    }>
  | Readonly<{ kind: 'mappings'; input: DirectoryMappings }>
  | Readonly<{ kind: 'adopt'; input: DirectoryAdopt }>
  | Readonly<{
      kind: 'unlink';
      targetWorkspaceId: string;
      input: { expectedRevision: number };
    }>;
export function applyDirectoryCommand(
  scope: FederationScope,
  command: DirectoryCommand,
  key: string,
) {
  const path = commandPath(command);
  return scope.apiClient.request({
    path: `${base(scope)}${path}`,
    method: command.kind === 'mappings' ? 'PUT' : 'POST',
    body: command.input,
    headers: { 'Idempotency-Key': key },
    response: {
      kind: 'json',
      decode: (value) => directoryChangedSchema.parse(value),
    },
  });
}

function commandPath(command: DirectoryCommand): string {
  if (command.kind === 'revoke')
    return `/credentials/${encodeURIComponent(command.credentialId)}/revoke`;
  if (command.kind === 'unlink')
    return `/workspaces/${encodeURIComponent(command.targetWorkspaceId)}/unlink`;
  return `/${command.kind}`;
}
