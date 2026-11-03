import { Controller } from '@nestjs/common';
import {
  notificationPreferenceRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../workspaces/http/route.js';
import { NoticePreferencesService } from './service.js';

/** A link in an email, which a mail client may follow signed out: the token is the authority. */
@Controller()
export class NoticeUnsubscribeController {
  constructor(private readonly preferences: NoticePreferencesService) {}

  @Route(routes.oneClick)
  oneClick(@In() { query }: RouteInput<typeof routes.oneClick>) {
    return this.preferences.unsubscribe(query.token);
  }

  @Route(routes.confirmOneClick)
  confirm(@In() { query }: RouteInput<typeof routes.confirmOneClick>) {
    return {
      url: `/notifications/unsubscribe#${encodeURIComponent(query.token)}`,
    };
  }

  @Route(routes.unsubscribe)
  unsubscribe(@In() { headers }: RouteInput<typeof routes.unsubscribe>) {
    return this.preferences.unsubscribe(headers['x-pertexo-unsubscribe-key']);
  }
}
