import { createRequire } from 'node:module';

import { liveWebOrigin } from '../web-origin.js';

export const enabled =
  process.env.WORKFLOW_CONCURRENCY_BROWSER_INTEGRATION === 'true';

export const webOrigin = liveWebOrigin;

export const webDirectory = new URL('../../../../web/', import.meta.url);

export const webRequire = createRequire(new URL('package.json', webDirectory));
