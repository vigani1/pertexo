import {
  federationSettingsSchema,
  type FederationSettings,
  type FederationOrganizationCreate,
  type FederationWorkspaceLink,
  type FederationDomainCreate,
  type FederationRevisionCommand,
  type FederationEnforcement,
  type OidcProviderCreate,
  type OidcProviderUpdate,
} from '@pertexo/contracts';
import type { WorkspaceApiScope } from '@/lib/api/workspace-scope';
export type FederationScope = WorkspaceApiScope;
export type FederationCommand =
  | Readonly<{
      kind: 'createOrganization';
      input: FederationOrganizationCreate;
    }>
  | Readonly<{ kind: 'linkWorkspace'; input: FederationWorkspaceLink }>
  | Readonly<{ kind: 'createDomain'; input: FederationDomainCreate }>
  | Readonly<{
      kind: 'verifyDomain' | 'renewDomain' | 'removeDomain';
      domainId: string;
      input: FederationRevisionCommand;
    }>
  | Readonly<{
      kind: 'enforcement';
      domainId: string;
      input: FederationEnforcement;
    }>
  | Readonly<{ kind: 'createProvider'; input: OidcProviderCreate }>
  | Readonly<{
      kind: 'updateProvider';
      providerId: string;
      input: OidcProviderUpdate;
    }>
  | Readonly<{
      kind: 'removeProvider';
      providerId: string;
      input: FederationRevisionCommand;
    }>;
function base(scope: FederationScope): `/v1${string}` {
  return `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/sso`;
}
export function readSettings(
  scope: FederationScope,
  signal: AbortSignal,
): Promise<FederationSettings> {
  return scope.apiClient.request({
    path: base(scope),
    signal,
    response: {
      kind: 'json',
      decode: (value) => federationSettingsSchema.parse(value),
    },
  });
}
function destination(
  command: FederationCommand,
): Readonly<{ path: string; method: 'POST' | 'PUT' }> {
  switch (command.kind) {
    case 'createOrganization':
      return { path: '/organization', method: 'POST' };
    case 'linkWorkspace':
      return { path: '/workspaces', method: 'POST' };
    case 'createDomain':
      return { path: '/domains', method: 'POST' };
    case 'verifyDomain':
      return {
        path: `/domains/${encodeURIComponent(command.domainId)}/verify`,
        method: 'POST',
      };
    case 'renewDomain':
      return {
        path: `/domains/${encodeURIComponent(command.domainId)}/renew`,
        method: 'POST',
      };
    case 'removeDomain':
      return {
        path: `/domains/${encodeURIComponent(command.domainId)}/remove`,
        method: 'POST',
      };
    case 'enforcement':
      return {
        path: `/domains/${encodeURIComponent(command.domainId)}/enforcement`,
        method: 'PUT',
      };
    case 'createProvider':
      return { path: '/providers', method: 'POST' };
    case 'updateProvider':
      return {
        path: `/providers/${encodeURIComponent(command.providerId)}`,
        method: 'PUT',
      };
    case 'removeProvider':
      return {
        path: `/providers/${encodeURIComponent(command.providerId)}/remove`,
        method: 'POST',
      };
  }
}
export function applyFederationCommand(
  scope: FederationScope,
  command: FederationCommand,
  key: string,
  signal: AbortSignal,
): Promise<FederationSettings> {
  const target = destination(command);
  return scope.apiClient.request({
    path: `${base(scope)}${target.path}`,
    method: target.method,
    body: command.input,
    headers: { 'Idempotency-Key': key },
    signal,
    response: {
      kind: 'json',
      decode: (value) => federationSettingsSchema.parse(value),
    },
  });
}
