import {
  BROWSABLE_WORKSPACE_STATUSES,
  UNPURGED_WORKSPACE_STATUSES,
} from '@pertexo/policy';
import { z } from 'zod';
import { problemResponse } from '../../openapi/primitives.js';
import * as schemas from '../../schemas/identity/federation/settings.js';
import { named as projected } from '../define.js';
const reading = {
  auth: 'session',
  capabilities: [
    {
      name: 'member:read',
      statuses: BROWSABLE_WORKSPACE_STATUSES,
      disclosure: 'forbidden',
    },
  ],
} as const;
const managing = {
  auth: 'session',
  capabilities: [
    {
      name: 'workspace:manage',
      statuses: UNPURGED_WORKSPACE_STATUSES,
      disclosure: 'forbidden',
    },
  ],
} as const;
const workspace = z.object({ workspaceId: z.uuid() }).strict();

import { defineRoute } from '../define.js';
const sharedProblems1 = {
  '400': problemResponse('Invalid request or configuration missing'),
  '401': problemResponse('Session required'),
  '403': problemResponse('Owner authority or CSRF refused'),
  '404': problemResponse('Resource unavailable'),
  '409': problemResponse('Settings changed or command conflict'),
  '429': problemResponse('Rate limited'),
  '500': problemResponse('Unexpected failure'),
  '503': problemResponse('Identity provider unavailable'),
};
const managementCommand = {
  method: 'post',
  access: managing,
  rateLimit: 'ordinary_mutation',
  idempotent: true,
  success: {
    status: 200,
    description: 'Safe organization sign-in settings',
    body: projected('FederationSettings', schemas.federationSettingsSchema),
  },
  problems: sharedProblems1,
} as const;
export const federationRoutes = {
  settings: defineRoute({
    operationId: 'readFederationSettings',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/sso',
    params: workspace,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: 'private, no-store',
    success: {
      status: 200,
      description: 'Safe organization sign-in settings',
      body: projected('FederationSettings', schemas.federationSettingsSchema),
    },
    problems: sharedProblems1,
  }),
  create: defineRoute({
    ...managementCommand,
    operationId: 'createIdentityOrganization',
    path: '/v1/workspaces/{workspaceId}/sso/organization',
    params: workspace,
    body: projected(
      'FederationOrganizationCreate',
      schemas.federationOrganizationCreateSchema,
    ),
    success: {
      status: 201,
      description: 'Safe organization sign-in settings',
      body: projected('FederationSettings', schemas.federationSettingsSchema),
    },
  }),
  link: defineRoute({
    ...managementCommand,
    operationId: 'linkIdentityOrganizationWorkspace',
    path: '/v1/workspaces/{workspaceId}/sso/workspaces',
    params: workspace,
    body: projected(
      'FederationWorkspaceLink',
      schemas.federationWorkspaceLinkSchema,
    ),
  }),
  domain: defineRoute({
    ...managementCommand,
    operationId: 'createIdentityDomain',
    path: '/v1/workspaces/{workspaceId}/sso/domains',
    params: workspace,
    body: projected(
      'FederationDomainCreate',
      schemas.federationDomainCreateSchema,
    ),
    success: {
      status: 201,
      description: 'Safe organization sign-in settings',
      body: projected('FederationSettings', schemas.federationSettingsSchema),
    },
  }),
  verify: defineRoute({
    ...managementCommand,
    operationId: 'verifyIdentityDomain',
    path: '/v1/workspaces/{workspaceId}/sso/domains/{domainId}/verify',
    params: workspace.extend({ domainId: z.uuid() }).strict(),
    body: projected(
      'FederationRevisionCommand',
      schemas.federationRevisionCommandSchema,
    ),
  }),
  renew: defineRoute({
    ...managementCommand,
    operationId: 'renewIdentityDomainChallenge',
    path: '/v1/workspaces/{workspaceId}/sso/domains/{domainId}/renew',
    params: workspace.extend({ domainId: z.uuid() }).strict(),
    body: projected(
      'FederationRevisionCommand',
      schemas.federationRevisionCommandSchema,
    ),
  }),
  removeDomain: defineRoute({
    ...managementCommand,
    operationId: 'removeIdentityDomain',
    path: '/v1/workspaces/{workspaceId}/sso/domains/{domainId}/remove',
    params: workspace.extend({ domainId: z.uuid() }).strict(),
    body: projected(
      'FederationRevisionCommand',
      schemas.federationRevisionCommandSchema,
    ),
  }),
  enforce: defineRoute({
    ...managementCommand,
    operationId: 'configureIdentityDomainEnforcement',
    method: 'put',
    path: '/v1/workspaces/{workspaceId}/sso/domains/{domainId}/enforcement',
    params: workspace.extend({ domainId: z.uuid() }).strict(),
    body: projected(
      'FederationEnforcement',
      schemas.federationEnforcementSchema,
    ),
  }),
  provider: defineRoute({
    ...managementCommand,
    operationId: 'createIdentityProvider',
    path: '/v1/workspaces/{workspaceId}/sso/providers',
    params: workspace,
    body: projected(
      'FederationProviderCreate',
      schemas.federationProviderCreateSchema,
    ),
    success: {
      status: 201,
      description: 'Safe organization sign-in settings',
      body: projected('FederationSettings', schemas.federationSettingsSchema),
    },
  }),
  updateProvider: defineRoute({
    ...managementCommand,
    operationId: 'updateIdentityProvider',
    method: 'put',
    path: '/v1/workspaces/{workspaceId}/sso/providers/{providerId}',
    params: workspace.extend({ providerId: z.uuid() }).strict(),
    body: projected(
      'FederationProviderUpdate',
      schemas.federationProviderUpdateSchema,
    ),
  }),
  metadata: defineRoute({
    operationId: 'downloadSamlServiceProviderMetadata',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/sso/saml/metadata',
    params: workspace,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: 'private, no-store',
    success: {
      status: 200,
      description: 'Bounded SP metadata for XML download',
      body: projected('SamlMetadata', schemas.samlMetadataSchema),
    },
    problems: sharedProblems1,
  }),
  removeProvider: defineRoute({
    ...managementCommand,
    operationId: 'removeIdentityProvider',
    path: '/v1/workspaces/{workspaceId}/sso/providers/{providerId}/remove',
    params: workspace.extend({ providerId: z.uuid() }).strict(),
    body: projected(
      'FederationRevisionCommand',
      schemas.federationRevisionCommandSchema,
    ),
  }),
};
