import { createRequire } from 'node:module';

import { liveWebOrigin } from '../web-origin.js';

import { z } from 'zod';

export const enabled =
  process.env.F07_ORGANIZATION_BROWSER_INTEGRATION === 'true' &&
  process.env.F07_ORGANIZATION_OWNED_FIXTURE === 'true';

export const webOrigin = liveWebOrigin;

export const webDirectory = new URL('../../../../web/', import.meta.url);

export const webRequire = createRequire(new URL('package.json', webDirectory));

export const evidenceSchema = z
  .object({
    workspaceId: z.uuid(),
    workflowIds: z.array(z.uuid()).length(2),
    folderId: z.uuid(),
    tagId: z.uuid(),
  })
  .strict();

export const matrixSchema = z
  .object({
    workspaceId: z.uuid(),
    workflowIds: z.array(z.uuid()).length(2),
    role: z.enum(['viewer', 'builder', 'admin']),
    partialStatuses: z.tuple([z.literal('updated'), z.literal('conflict')]),
    privateReadIsolation: z.literal(true),
    privateWriteIsolation: z.boolean(),
    archivedMove: z.literal(true),
    archivedTagCleanup: z.literal(true),
    restored: z.literal(true),
    roleEditingBoundary: z.literal(true),
  })
  .strict();
