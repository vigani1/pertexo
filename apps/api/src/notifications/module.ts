import { Module, type DynamicModule } from '@nestjs/common';

import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import { NotificationsController } from './controllers.js';
import { NotificationReadGuard } from './guards.js';
import type { InboxHintSource } from './inbox-hint-hub.js';
import { WorkspaceInboxService } from './service.js';
import { INBOX_HINT_SOURCE, NOTIFICATION_AUTHORIZATION } from './tokens.js';

@Module({})
// Nest dynamic modules require a class container.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class NotificationsModule {
  public static register(
    service: WorkspaceInboxService,
    hints: InboxHintSource,
    authorization: WorkspaceAuthorizationSource,
    identityModule: DynamicModule,
  ): DynamicModule {
    return {
      module: NotificationsModule,
      imports: [identityModule],
      controllers: [NotificationsController],
      providers: [
        { provide: WorkspaceInboxService, useValue: service },
        { provide: INBOX_HINT_SOURCE, useValue: hints },
        { provide: NOTIFICATION_AUTHORIZATION, useValue: authorization },
        NotificationReadGuard,
      ],
    };
  }
}
