import type {
  WorkspaceInboxThread,
  WorkspaceNoticeKind,
} from '@pertexo/contracts';
import type { WorkspaceActor } from '../../shared/access/workspace-access.js';

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
