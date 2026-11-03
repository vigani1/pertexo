import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type AuthorizationCapability,
  type WorkspaceStatusList,
} from '@pertexo/policy';

import { formCapabilitySchema } from '../../schemas/forms/requests.js';
import { formUploadSessionSchema } from '../../schemas/forms/uploads.js';
import type { RouteAccess } from '../define.js';

export function session(
  name: AuthorizationCapability,
  statuses: WorkspaceStatusList = ACTIVE_WORKSPACE_STATUSES,
): RouteAccess {
  return {
    auth: 'session',
    capabilities: [{ name, statuses, disclosure: 'not_found' }],
  };
}
/** Members who may send a form response. */
export const responding = session('workspace:read');
export const readingForm = session(
  'workspace:read',
  BROWSABLE_WORKSPACE_STATUSES,
);
export const managing = session('workflow:update');
export const readingAsManager = session(
  'workflow:update',
  BROWSABLE_WORKSPACE_STATUSES,
);

export const capabilityHeader = formCapabilitySchema.describe(
  'Capability from the link fragment; session cookies grant no public access.',
);
export const sessionHeader = formUploadSessionSchema.describe(
  'Random token for one response. A submission can use only uploads begun with the same token.',
);
/** A public form's answers must not leak through caches or the referrer. */
export const publicAnswer = {
  cacheControl: 'no-store',
  responseHeaders: { 'Referrer-Policy': 'no-referrer' },
} as const;
