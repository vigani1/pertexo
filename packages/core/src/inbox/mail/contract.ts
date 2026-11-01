import type { SealedSystemMailPayload } from '@pertexo/database/platform';
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
/** The person a notice mail is prepared for: no member is acting, only addressed. */
export type NoticeMailPerson = Readonly<{
  workspace_id: string;
  user_id: string;
}>;
export type NoticeMailPersonFailure = Readonly<{
  workspaceId: string;
  actorId: string;
  /** In a row, so someone can tell a blip from a person whose mail never works. */
  failures: number;
  error: unknown;
}>;
export type NoticeMailSealer = (
  input: NoticeMailToSeal,
) => SealedSystemMailPayload;
