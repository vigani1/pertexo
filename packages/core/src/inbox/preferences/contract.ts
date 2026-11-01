import type {
  NoticePreferencesRequest,
  NoticeDefaultsRequest,
  NoticeSubscriptionRequest,
  NoticeSubjectParams,
} from '@pertexo/contracts';
import type { WorkspaceActor } from '../../shared/workspace-access.js';

export type NoticeSubject = Pick<
  NoticeSubjectParams,
  'subjectKind' | 'subjectId'
>;
export type ReplaceNoticePreferencesInput = WorkspaceActor &
  NoticePreferencesRequest &
  Readonly<{ idempotencyKey: string }>;
export type ReplaceNoticeDefaultsInput = WorkspaceActor &
  NoticeDefaultsRequest &
  Readonly<{ idempotencyKey: string }>;
export type ReadNoticeSubscriptionInput = WorkspaceActor & NoticeSubject;
export type ReplaceNoticeSubscriptionInput = WorkspaceActor &
  NoticeSubject &
  NoticeSubscriptionRequest &
  Readonly<{ idempotencyKey: string }>;
export type UnsubscribeNoticeMailInput = WorkspaceActor &
  Readonly<{ revision: number; memberRevision: number }>;

export class NoticeConflictError extends Error {
  override readonly name = 'NoticeConflictError';
  constructor() {
    super('Notification settings changed. Reload and try again.');
  }
}
export class NoticeUnavailableError extends Error {
  override readonly name = 'NoticeUnavailableError';
}
