import type {
  WorkspaceInboxThread,
  WorkspaceNoticeKind,
} from '@pertexo/contracts';
import type { WorkspaceActor } from '../../shared/workspace-access.js';

/** The terminal run statuses that raise a notice (ADR 055). */
export const WORKSPACE_INBOX_FAILURE_KINDS = [
  'failed',
  'timed_out',
  'outcome_unknown',
] as const;
export type WorkspaceInboxFailureKind =
  (typeof WORKSPACE_INBOX_FAILURE_KINDS)[number];
export type WorkspaceInboxThreadRecord = WorkspaceInboxThread;
export type WorkspaceInboxCursor = Readonly<{
  latestOccurredAt: string;
  threadId: string;
}>;
export type WorkspaceInboxThreadPage = Readonly<{
  items: readonly WorkspaceInboxThread[];
  next: WorkspaceInboxCursor | null;
  revision: string;
}>;
export type WorkspaceInboxSummary = Readonly<{
  unreadCount: number;
  revision: string;
}>;
export type ListThreadsInput = WorkspaceActor &
  Readonly<{
    filter: 'all' | 'unread';
    noticeKind?: WorkspaceNoticeKind;
    limit: number;
    after?: WorkspaceInboxCursor;
  }>;
export type MarkThreadReadInput = WorkspaceActor &
  Readonly<{ threadId: string; revision: string }>;
export type MarkAllReadInput = WorkspaceActor & Readonly<{ revision: string }>;
