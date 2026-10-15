import {
  noticePreferencesResponseSchema,
  noticeSubscriptionSchema,
  noticeCommandResponseSchema,
} from '@pertexo/contracts';
import {
  NoticeConflictError,
  NoticeUnavailableError,
  type NoticePreferencesStore,
} from '@pertexo/database/notifications';
import { WorkspaceAccessDeniedError } from '@pertexo/database/tenant-access';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import {
  openNoticeUnsubscribe,
  type ApplicationSecretEnvelope,
} from '@pertexo/integrations/server';
import {
  applicationError,
  throwApplicationError,
} from '../../platform/http/index.js';
async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NoticeConflictError)
      return throwApplicationError(
        applicationError('notifications.changed', {
          safeDetail: error.message,
        }),
      );
    if (error instanceof NoticeUnavailableError)
      return throwApplicationError(
        applicationError('notifications.unavailable', {
          safeDetail: error.message,
        }),
      );
    if (error instanceof WorkspaceAccessDeniedError)
      return throwApplicationError(applicationError('resource.not_found'));
    if (error instanceof IdempotencyConflictError)
      return throwApplicationError(
        applicationError('request.idempotency_conflict'),
      );
    throw error;
  }
}
export class NoticePreferencesService {
  constructor(
    private readonly store: NoticePreferencesStore,
    private readonly envelope: ApplicationSecretEnvelope | undefined,
  ) {}
  read(input: Parameters<NoticePreferencesStore['read']>[0]) {
    return operation(async () =>
      noticePreferencesResponseSchema.parse(await this.store.read(input)),
    );
  }
  replace(input: Parameters<NoticePreferencesStore['replace']>[0]) {
    return operation(async () =>
      noticeCommandResponseSchema.parse(await this.store.replace(input)),
    );
  }
  replaceDefaults(
    input: Parameters<NoticePreferencesStore['replaceDefaults']>[0],
  ) {
    return operation(async () =>
      noticeCommandResponseSchema.parse(
        await this.store.replaceDefaults(input),
      ),
    );
  }
  subscription(
    input: Parameters<NoticePreferencesStore['readSubscription']>[0],
  ) {
    return operation(async () =>
      noticeSubscriptionSchema.parse(await this.store.readSubscription(input)),
    );
  }
  replaceSubscription(
    input: Parameters<NoticePreferencesStore['replaceSubscription']>[0],
  ) {
    return operation(async () =>
      noticeCommandResponseSchema.parse(
        await this.store.replaceSubscription(input),
      ),
    );
  }
  async unsubscribe(token: string) {
    const claims =
      this.envelope === undefined
        ? null
        : openNoticeUnsubscribe(this.envelope, token, new Date());
    if (claims !== null) {
      try {
        if (await this.store.unsubscribe(claims))
          return { unsubscribed: true as const };
      } catch (error) {
        if (!(error instanceof WorkspaceAccessDeniedError)) throw error;
      }
    }
    return throwApplicationError(
      applicationError('notifications.unsubscribe_unavailable', {
        safeDetail:
          'This unsubscribe link is unavailable. Sign in and turn off personal email in Notification settings.',
      }),
    );
  }
}
