import { verifyCallbackEvidence } from '../evidence/callbacks/verify.js';

import { verifyNotificationEvidence } from '../evidence/notifications/verify.js';
import { verifyVariableEvidence } from '../evidence/variables/verify.js';
import { verifyFormEvidence } from '../evidence/forms/verify.js';
import { verifyFormUploadEvidence } from '../evidence/forms/uploads.js';
import { verifyApprovalEvidence } from '../evidence/approvals/verify.js';
import { verifyTaskTimeoutEvidence } from '../evidence/approvals/timeouts.js';

import { expect } from 'vitest';

import { noticeMessages } from '../fixture/state.js';
import type { EditorBrowserJourneyContext } from '../fixture/contract.js';

export async function verifyEditorOrganizationOidcOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  expect(
    (await api.database().query('select 1 from app.auth_provider_checks'))
      .rowCount,
  ).toBe(2);
  expect(
    (
      await api
        .database()
        .query(
          'select 1 from app.auth_accounts where access_token is not null or refresh_token is not null or id_token is not null',
        )
    ).rowCount,
  ).toBe(0);
  return;
}

export function verifyEditorTwoFactorOutcome(
  _context: EditorBrowserJourneyContext,
) {
  return;
}

export async function verifyEditorFederationOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  const providers = await api
    .database()
    .query<{ count: number; token_count: number }>(
      "select count(*)::int count,count(*) filter(where access_token is not null or refresh_token is not null or id_token is not null)::int token_count from app.auth_accounts where provider_id in ('google','github','apple')",
    );
  expect(providers.rows).toEqual([{ count: 6, token_count: 0 }]);
  const attempts = await api
    .database()
    .query<{ count: number }>(
      'select count(*)::int count from app.auth_sign_in_attempts where consumed_at is not null',
    );
  expect(attempts.rows[0]?.count).toBe(6);
  return;
}

export async function verifyEditorNotificationsOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  await verifyNotificationEvidence(api.database(), noticeMessages);
  return;
}

export async function verifyEditorCollaborationOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  const rows = await api
    .database()
    .query<{ comments: number; mentions: number }>(
      'select (select count(*)::int from app.workflow_comments) comments,(select count(*)::int from app.workflow_comment_mentions) mentions',
    );
  expect(rows.rows[0]?.comments).toBeGreaterThanOrEqual(2);
  expect(rows.rows[0]?.mentions).toBeGreaterThanOrEqual(1);
  return;
}

export async function verifyEditorPromotionOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  const rows = await api
    .database()
    .query<{ origins: number; versions: number }>(
      `select (select count(*)::int from app.workflow_promotion_origins) origins,(select count(*)::int from app.workflow_version_promotions) versions`,
    );
  expect(rows.rows[0]).toEqual({ origins: 2, versions: 2 });
  return;
}

export async function verifyEditorGovernanceOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  const rows = await api
    .database()
    .query<{ count: number }>(
      "select count(*)::int count from app.audit_events where action='workspace.governance_changed' and metadata->>'auditRetentionDays'='30'",
    );
  expect(rows.rows[0]?.count).toBe(2);
  return;
}

export async function verifyEditorVariablesOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  await verifyVariableEvidence(api.database());
  return;
}

export async function verifyEditorFormsOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  await verifyFormEvidence(api.database());
  return;
}

export async function verifyEditorFormUploadsOutcome(
  context: EditorBrowserJourneyContext,
) {
  await verifyFormUploadEvidence(context.api.database());
}

export async function verifyEditorTaskTimeoutsOutcome(
  context: EditorBrowserJourneyContext,
) {
  await verifyTaskTimeoutEvidence(context.api.database());
}

export async function verifyEditorApprovalsOutcome(
  context: EditorBrowserJourneyContext,
) {
  const { api } = context;
  await verifyApprovalEvidence(api.database());
  await verifyCallbackEvidence(api.database());
  return;
}
