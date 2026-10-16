import { z } from 'zod';
import { storageTextSchema } from '../json/text.js';

function noCredentials(value: string): boolean {
  const url = URL.parse(value);
  return url !== null && url.username === '' && url.password === '';
}
export const formLinkUrlSchema = storageTextSchema.pipe(
  z
    .url({ protocol: /^https?$/u })
    .max(2048)
    .refine(
      noCredentials,
      'Use an HTTP or HTTPS URL without embedded credentials.',
    ),
);
/** Published destinations are fixed HTTPS URLs, never submitted values or expressions. */
export const formRedirectUrlSchema = storageTextSchema.pipe(
  z
    .url({ protocol: /^https$/u })
    .max(2048)
    .refine(noCredentials, 'Use an HTTPS URL without embedded credentials.'),
);
