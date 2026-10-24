import type {
  WorkspaceInboxThread,
  WorkspaceNoticeKind,
} from '@pertexo/contracts';
export type WorkspaceInboxFailureKind =
  'failed' | 'timed_out' | 'outcome_unknown';
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
export type ReaderScope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
export interface WorkspaceInboxDatabase {
  listThreads(
    input: ReaderScope &
      Readonly<{
        filter: 'all' | 'unread';
        noticeKind?: WorkspaceNoticeKind;
        limit: number;
        after?: WorkspaceInboxCursor;
      }>,
  ): Promise<WorkspaceInboxThreadPage>;
  readSummary(input: ReaderScope): Promise<WorkspaceInboxSummary>;
  markThreadRead(
    input: ReaderScope & Readonly<{ threadId: string; revision: string }>,
  ): Promise<Readonly<{ unread: boolean; revision: string }> | undefined>;
  markAllRead(
    input: ReaderScope & Readonly<{ revision: string }>,
  ): Promise<Readonly<{ marked: number }>>;
  close(): Promise<void>;
}
