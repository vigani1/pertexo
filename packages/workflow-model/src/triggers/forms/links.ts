import { z } from 'zod';
import { storageTextSchema } from '../../values/json/text.js';

// Browsers and proxies reliably carry URLs up to this length.
const FORM_LINK_URL_LENGTH = 2_048;

function noCredentials(value: string): boolean {
  const url = URL.parse(value);
  return url !== null && url.username === '' && url.password === '';
}
export const formLinkUrlSchema = storageTextSchema.pipe(
  z
    .url({ protocol: /^https?$/u })
    .max(FORM_LINK_URL_LENGTH)
    .refine(
      noCredentials,
      'Use an HTTP or HTTPS URL without embedded credentials.',
    ),
);
/** Published destinations are fixed HTTPS URLs, never submitted values or expressions. */
export const formRedirectUrlSchema = storageTextSchema.pipe(
  z
    .url({ protocol: /^https$/u })
    .max(FORM_LINK_URL_LENGTH)
    .refine(noCredentials, 'Use an HTTPS URL without embedded credentials.'),
);
