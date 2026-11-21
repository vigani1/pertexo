import { HTTP_MODULE } from './http/http.module.js';
import { SLACK_MODULE } from './slack/slack.module.js';
import { DATABASE_MODULE } from './database/database.module.js';
import { EMAIL_MODULE } from './email/email.module.js';
import { SIGNING_MODULE } from './signing/signing.module.js';
import { EXAMPLE_POSTS_MODULE } from './example-posts/example-posts.module.js';
import type { IntegrationModule } from './providers/integration-module.js';

export const INTEGRATION_MODULES = Object.freeze([
  HTTP_MODULE,
  SLACK_MODULE,
  DATABASE_MODULE,
  EMAIL_MODULE,
  SIGNING_MODULE,
  EXAMPLE_POSTS_MODULE,
] as const satisfies readonly IntegrationModule[]);
