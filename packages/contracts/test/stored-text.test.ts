import { formUploadRequestSchema } from '../src/schemas/forms/uploads.js';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { connectionNameSchema } from '../src/schemas/connection-fields.js';
import {
  workspaceCreateRequestSchema,
  workspaceRenameRequestSchema,
  workspaceDeletionRequestSchema,
  userDisplayNameSchema,
} from '../src/schemas/identity/workspaces.js';
import { apiTokenCreateRequestSchema } from '../src/schemas/identity/api-tokens.js';
import { directoryCredentialCreateSchema } from '../src/schemas/identity/federation/directory.js';
import {
  federationOrganizationCreateSchema,
  oidcConfigurationSchema,
} from '../src/schemas/identity/federation/settings.js';
import { workflowNameSchema } from '../src/schemas/workflows/authoring.js';
import { workflowImportRequestSchema } from '../src/schemas/workflows/portability.js';
import { workflowFolderNameInputSchema } from '../src/schemas/workflows/organization-folders.js';
import {
  publicationReviewRequestSchema,
  publicationReviewDecisionSchema,
} from '../src/schemas/workflows/publication-review.js';
import { workflowPromotionApplySchema } from '../src/schemas/workflows/promotions/promotion-commands.js';
import { workflowRunCancelRequestSchema } from '../src/schemas/execution/runs.js';
import { pendingTaskDecisionRequestSchema } from '../src/schemas/execution/pending-tasks.js';

const fields: readonly [string, z.ZodType, number, boolean][] = [
  ['form upload filename', formUploadRequestSchema.shape.filename, 1024, false],
  ['OIDC client ID', oidcConfigurationSchema.shape.clientId, 512, false],
  ['OIDC claim name', oidcConfigurationSchema.shape.nameClaim, 256, false],
  ['workspace creation', workspaceCreateRequestSchema.shape.name, 128, false],
  ['workspace rename', workspaceRenameRequestSchema.shape.name, 128, false],
  [
    'workspace deletion reason',
    workspaceDeletionRequestSchema.shape.reason,
    512,
    false,
  ],
  ['profile display name', userDisplayNameSchema, 128, false],
  ['connection name', connectionNameSchema, 128, false],
  ['API token name', apiTokenCreateRequestSchema.shape.name, 128, false],
  [
    'directory credential name',
    directoryCredentialCreateSchema.shape.name,
    128,
    false,
  ],
  [
    'federation organization name',
    federationOrganizationCreateSchema.shape.name,
    128,
    false,
  ],
  ['workflow name', workflowNameSchema, 128, false],
  [
    'imported workflow name',
    workflowImportRequestSchema.shape.name,
    128,
    false,
  ],
  ['folder name', workflowFolderNameInputSchema, 128, false],
  [
    'publication review note',
    publicationReviewRequestSchema.shape.note,
    1000,
    false,
  ],
  [
    'publication review comment',
    publicationReviewDecisionSchema.shape.comment,
    1000,
    true,
  ],
  ['promotion note', workflowPromotionApplySchema.shape.note, 1000, false],
  [
    'run cancellation reason',
    workflowRunCancelRequestSchema.shape.reason,
    500,
    false,
  ],
  [
    'approval comment',
    pendingTaskDecisionRequestSchema.shape.comment,
    2000,
    true,
  ],
];

describe.each(fields)(
  '%s stored text admission',
  (_name, schema, maximum, emptyAllowed) => {
    it.each(['bad\0name', 'bad\ud800name', 'bad\udc00name'])(
      'refuses text that PostgreSQL cannot preserve: %j',
      (text) => {
        expect(schema.safeParse(text).success).toBe(false);
      },
    );
    it('retains trimming, valid Unicode and the existing length bounds', () => {
      expect(schema.parse('  Équipe 😀  ')).toBe('Équipe 😀');
      expect(schema.parse('  E\u0301quipe 👩‍💻  ')).toBe('E\u0301quipe 👩‍💻');
      expect(schema.safeParse('x'.repeat(maximum)).success).toBe(true);
      expect(schema.safeParse('x'.repeat(maximum + 1)).success).toBe(false);
      expect(schema.safeParse('').success).toBe(emptyAllowed);
    });
  },
);
