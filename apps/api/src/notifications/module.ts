import { NoticePreferencesService } from './preferences/notice-preferences.service.js';
import { NoticePreferencesController } from './preferences/controller.js';
import { NoticeUnsubscribeController } from './preferences/unsubscribe.controller.js';
import { Module, type DynamicModule } from '@nestjs/common';

import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { NotificationsController } from './controllers.js';
import { WORKSPACE_AUTHORIZATION } from '../workspaces/tokens.js';
import type { InboxHintSource } from './inbox-hint-hub.js';
import { WorkspaceInboxService } from './workspace-inbox.service.js';
import { INBOX_HINT_SOURCE, NOTIFICATION_AUTHORIZATION } from './tokens.js';

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class NotificationsModule {
  public static register(
    service: WorkspaceInboxService,
    hints: InboxHintSource,
    {
      authorization,
      identityModule,
      preferences,
    }: Readonly<{
      authorization: WorkspaceAuthorizationSource;
      identityModule: DynamicModule;
      preferences?: NoticePreferencesService | undefined;
    }>,
  ): DynamicModule {
    return {
      module: NotificationsModule,
      imports: [identityModule],
      controllers: [
        NotificationsController,
        ...(preferences === undefined
          ? []
          : [NoticePreferencesController, NoticeUnsubscribeController]),
      ],
      providers: [
        { provide: WorkspaceInboxService, useValue: service },
        ...(preferences === undefined
          ? []
          : [{ provide: NoticePreferencesService, useValue: preferences }]),
        { provide: INBOX_HINT_SOURCE, useValue: hints },
        { provide: NOTIFICATION_AUTHORIZATION, useValue: authorization },
        { provide: WORKSPACE_AUTHORIZATION, useValue: authorization },
      ],
    };
  }
}
