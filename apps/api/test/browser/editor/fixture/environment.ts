import { randomBytes } from 'node:crypto';

import { createRequire } from 'node:module';

import { z } from 'zod';

import { liveWebOrigin } from '../../web-origin.js';

export const enabled = process.env.EDITOR_BROWSER_INTEGRATION === 'true';

export const scenario = z
  .enum([
    'nested-conflict',
    'receipts',
    'run-recovery',
    'expression-admission',
    'readonly',
    'schedule',
    'webhook-controlled-http',
    'failure-routing',
    'error-workflows',
    'approvals',
    'forms',
    'variables',
    'run-values',
    'governance',
    'promotion',
    'collaboration',
    'federation',
    'two-factor',
    'http-pagination',
    'organization-oidc',
    'notifications',
    'transforms',
    'artifact-inputs',
    'api-tokens',
    'duplication',
    'portability',
    'input-cases',
    'code',
    'pinned-samples',
    'webhook-responses',
    'curated-templates',
    'callable',
  ])
  .parse(process.env.EDITOR_BROWSER_CASE ?? 'nested-conflict');

export const webOrigin = liveWebOrigin;

export const callbackConfig = {
  origin: webOrigin,
  keys: {
    current: { version: '1', key: Buffer.alloc(32, 71).toString('base64url') },
    previous: [],
  },
};

export const workerDirectory = new URL(
  '../../../../../worker/',
  import.meta.url,
);

export const webDirectory = new URL('../../../../../web/', import.meta.url);

export const webRequire = createRequire(new URL('package.json', webDirectory));

export const noticeMailKey =
  scenario === 'notifications' ? randomBytes(32).toString('base64') : undefined;

export const controlledHttpScenario =
  scenario === 'webhook-controlled-http' ||
  scenario === 'failure-routing' ||
  scenario === 'artifact-inputs' ||
  scenario === 'http-pagination';

export const browserEvidenceSchema = z.strictObject({
  runId: z.uuid(),
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  workflowVersionId: z.uuid(),
  rootId: z.uuid(),
  outerId: z.uuid(),
  innerId: z.uuid(),
  leafId: z.uuid(),
  outsiderWorkspaceId: z.uuid(),
  conflictRevision: z.number().int().positive(),
  finalDraftRevision: z.number().int().positive(),
});

export function editorJourneyPath(selected: typeof scenario): string {
  if (selected === 'artifact-inputs')
    return process.env.F45_RELEASE_QUALIFICATION === 'true'
      ? 'editor/files/maximum-upload.spec.ts'
      : 'editor/files/';
  return EDITOR_JOURNEY_PATHS[selected];
}

const EDITOR_JOURNEY_PATHS = {
  'run-values': 'editor/run-values/journey.spec.ts',
  'http-pagination': 'editor/http-pagination.spec.ts',
  'two-factor': 'authentication/two-factor.spec.ts',
  federation: 'editor/federation/sign-in.spec.ts',
  'organization-oidc': 'editor/federation/organization.spec.ts',
  collaboration: 'editor/collaboration',
  promotion: 'editor/promotions',
  governance: 'editor/governance',
  code: 'editor/code.spec.ts',
  'webhook-responses': 'editor/webhook-responses.spec.ts',
  'pinned-samples': 'editor/pinned-samples.spec.ts',
  notifications: 'editor/notifications/attention.spec.ts',
  variables: 'editor/variables/snapshots.spec.ts',
  forms: 'editor/forms/submission.spec.ts',
  approvals: 'editor/approvals.spec.ts',
  'error-workflows': 'editor/error-workflows.spec.ts',
  'api-tokens': 'api-tokens.spec.ts',
  callable: 'editor/callable',
  'curated-templates': 'curated-templates.spec.ts',
  portability: 'workflow-portability.spec.ts',
  'input-cases': 'workflow-input-cases.spec.ts',
  duplication: 'workflow-duplication.spec.ts',
  'nested-conflict': 'editor/execution.spec.ts',
  receipts: 'editor/receipts.spec.ts',
  'run-recovery': 'editor/run-recovery.spec.ts',
  'expression-admission': 'editor/expression-admission.spec.ts',
  readonly: 'editor/readonly.spec.ts',
  schedule: 'editor/schedule.spec.ts',
  'failure-routing': 'editor/failure-routing.spec.ts',
  transforms: 'editor/transforms.spec.ts',
  'webhook-controlled-http': 'editor/webhook-controlled-http.spec.ts',
} satisfies Record<Exclude<typeof scenario, 'artifact-inputs'>, string>;
