import type { SealedSystemMailPayload } from '../../platform/mail/repository.js';
import type { WorkspaceNoticeKind } from '@pertexo/contracts';
type NoticeMailBase = Readonly<{
  id: string;
  revision: string;
  name: string;
  count: number;
  subjectId: string;
  workflowId: string | null;
}>;
export type NoticeMailItem = NoticeMailBase &
  (
    | Readonly<{ noticeKind: Exclude<WorkspaceNoticeKind, 'workflow_mention'> }>
    | Readonly<{
        noticeKind: 'workflow_mention';
        workflowId: string;
        discussion: Readonly<{ threadId: string; commentId: string }>;
      }>
  );
export type NoticeMailToSeal = Readonly<{
  id: string;
  expiresAt: Date;
  toEmail: string;
  workspaceId: string;
  workspaceName: string;
  actorId: string;
  revision: number;
  memberRevision: number;
  items: readonly NoticeMailItem[];
}>;
export interface NoticeMailStore {
  prepare(signal?: AbortSignal): Promise<number>;
  authorize(deliveryId: string): Promise<boolean>;
  close(): Promise<void>;
}
export type NoticeMailSealer = (
  input: NoticeMailToSeal,
) => SealedSystemMailPayload;
