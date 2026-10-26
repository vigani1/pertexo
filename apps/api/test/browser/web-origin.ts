import { z } from 'zod';

// One live run per web port, so concurrent runs on one machine pick their own.
// The SAML journey serves its cross-site HTTPS app on the next port up.
export const liveWebPort = z.coerce
  .number()
  .int()
  .min(1024)
  .max(65534)
  .parse(process.env.PERTEXO_LIVE_WEB_PORT ?? '4174');

export const liveWebOrigin = `http://127.0.0.1:${String(liveWebPort)}`;
