import {
  noticePreferencesResponseSchema,
  noticeSubscriptionSchema,
  noticeCommandResponseSchema,
} from '@pertexo/contracts';
import type { NoticePreferencesStore } from '@pertexo/core/inbox';
import { WorkspaceAccessDeniedError } from '@pertexo/core/tenant-access';

import {
  openNoticeUnsubscribe,
  type ApplicationSecretEnvelope,
} from '@pertexo/integrations/server';
import {
  applicationError,
  throwApplicationError,
} from '../../platform/http/index.js';

export class NoticePreferencesService {
  constructor(
    private readonly store: NoticePreferencesStore,
    private readonly envelope: ApplicationSecretEnvelope | undefined,
  ) {}
  async read(input: Parameters<NoticePreferencesStore['read']>[0]) {
    return noticePreferencesResponseSchema.parse(await this.store.read(input));
  }
  async replace(input: Parameters<NoticePreferencesStore['replace']>[0]) {
    return noticeCommandResponseSchema.parse(await this.store.replace(input));
  }
  async replaceDefaults(
    input: Parameters<NoticePreferencesStore['replaceDefaults']>[0],
  ) {
    return noticeCommandResponseSchema.parse(
      await this.store.replaceDefaults(input),
    );
  }
  async subscription(
    input: Parameters<NoticePreferencesStore['readSubscription']>[0],
  ) {
    return noticeSubscriptionSchema.parse(
      await this.store.readSubscription(input),
    );
  }
  async replaceSubscription(
    input: Parameters<NoticePreferencesStore['replaceSubscription']>[0],
  ) {
    return noticeCommandResponseSchema.parse(
      await this.store.replaceSubscription(input),
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
