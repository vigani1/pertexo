import type { SealedSystemMailPayload } from '../../platform/mail/store.js';
import type { WorkspaceNoticeKind } from '@pertexo/contracts';
export type NoticeMailItem = Readonly<{
  id: string;
  revision: string;
  noticeKind: WorkspaceNoticeKind;
  name: string;
  count: number;
  subjectId: string;
  workflowId: string | null;
}>;
export type NoticeMailToSeal = Readonly<{
  id: string;
  expiresAt: Date;
  toEmail: string;
  workspaceId: string;
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
