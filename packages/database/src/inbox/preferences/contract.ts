import type {
  NoticePreferencesRequest,
  NoticeDefaultsRequest,
  NoticePreferencesResponse,
  NoticeSubscription,
  NoticeSubscriptionRequest,
  NoticeCommandResponse,
  NoticeSubjectParams,
} from '@pertexo/contracts';
export type NoticeReader = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
export type NoticeSubject = Pick<
  NoticeSubjectParams,
  'subjectKind' | 'subjectId'
>;
export class NoticeConflictError extends Error {
  override readonly name = 'NoticeConflictError';
  constructor() {
    super('Notification settings changed. Reload and try again.');
  }
}
export class NoticeUnavailableError extends Error {
  override readonly name = 'NoticeUnavailableError';
}
export interface NoticePreferencesStore {
  read(input: NoticeReader): Promise<NoticePreferencesResponse>;
  replace(
    input: NoticeReader & NoticePreferencesRequest & { idempotencyKey: string },
  ): Promise<NoticeCommandResponse>;
  replaceDefaults(
    input: NoticeReader & NoticeDefaultsRequest & { idempotencyKey: string },
  ): Promise<NoticeCommandResponse>;
  readSubscription(
    input: NoticeReader & NoticeSubject,
  ): Promise<NoticeSubscription>;
  replaceSubscription(
    input: NoticeReader &
      NoticeSubject &
      NoticeSubscriptionRequest & { idempotencyKey: string },
  ): Promise<NoticeCommandResponse>;
  unsubscribe(
    input: Readonly<{
      workspaceId: string;
      actorId: string;
      revision: number;
      memberRevision: number;
    }>,
  ): Promise<boolean>;
  close(): Promise<void>;
}
