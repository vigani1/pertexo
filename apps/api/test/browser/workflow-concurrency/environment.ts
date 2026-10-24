import { createRequire } from 'node:module';

export const enabled =
  process.env.WORKFLOW_CONCURRENCY_BROWSER_INTEGRATION === 'true';

export const webOrigin = 'http://127.0.0.1:4174';

export const webDirectory = new URL('../../../../web/', import.meta.url);

export const webRequire = createRequire(new URL('package.json', webDirectory));
