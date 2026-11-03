import {
  noticePreferencesResponseSchema,
  noticeSubscriptionSchema,
  noticeCommandResponseSchema,
} from '@pertexo/contracts';
import type {
  NoticePreferencesStore,
  ReadNoticeSubscriptionInput,
  ReplaceNoticeDefaultsInput,
  ReplaceNoticePreferencesInput,
  ReplaceNoticeSubscriptionInput,
  WorkspaceActor,
} from '@pertexo/core/inbox';
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
  async read(input: WorkspaceActor) {
    return noticePreferencesResponseSchema.parse(await this.store.read(input));
  }
  async replace(input: ReplaceNoticePreferencesInput) {
    return noticeCommandResponseSchema.parse(await this.store.replace(input));
  }
  async replaceDefaults(input: ReplaceNoticeDefaultsInput) {
    return noticeCommandResponseSchema.parse(
      await this.store.replaceDefaults(input),
    );
  }
  async subscription(input: ReadNoticeSubscriptionInput) {
    return noticeSubscriptionSchema.parse(
      await this.store.readSubscription(input),
    );
  }
  async replaceSubscription(input: ReplaceNoticeSubscriptionInput) {
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
