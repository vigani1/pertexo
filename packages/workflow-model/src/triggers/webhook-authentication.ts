import { z } from 'zod';

const reservedHeader =
  /^(?:accept(?:-|$)|access-control-|content-|sec-|proxy-|x-forwarded(?:-|$)|x-real-ip$|x-pertexo-|x-request-id$|x-correlation-id$|traceparent$|tracestate$|baggage$|cookie$|set-cookie$|host$|origin$|referer$|user-agent$|connection$|keep-alive$|te$|trailer$|transfer-encoding$|upgrade$|idempotency-key$|expect$|date$|via$|forwarded$|range$|cache-control$|pragma$|dnt$)/u;
const credentialHeader = z
  .string()
  .min(1, 'Enter a header name.')
  .max(64, 'Use a header name of at most 64 characters.')
  .regex(
    /^[a-z][a-z0-9-]*$/u,
    'Use a lowercase header name with letters, digits and hyphens.',
  )
  .refine(
    (name) => name === 'authorization' || !reservedHeader.test(name),
    'Choose Authorization or a dedicated webhook-secret header.',
  );
const normalizedHttpUrl = z.url({ protocol: /^https?$/u, normalize: true });
const origin = z
  .string()
  .max(512, 'Use an origin of at most 512 characters.')
  .refine((value) => {
    const parsed = normalizedHttpUrl.safeParse(value);
    return (
      parsed.success &&
      parsed.data === `${value}/` &&
      /^https?:\/\/[^/?#@*]+$/u.test(value)
    );
  }, 'Use an exact http or https origin, without a path or trailing slash.');
const origins = z
  .array(origin)
  .max(20, 'Use at most 20 browser origins.')
  .refine(
    (values) => new Set(values).size === values.length,
    'Origins must be distinct.',
  );

export const webhookAuthenticationSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('signed'),
      allowedOrigins: z.array(z.never()).max(0),
    })
    .strict(),
  z.object({ mode: z.literal('secret_url'), allowedOrigins: origins }).strict(),
  z
    .object({
      mode: z.literal('header_secret'),
      headerName: credentialHeader,
      allowedOrigins: origins,
    })
    .strict(),
]);
export type WebhookAuthentication = z.output<
  typeof webhookAuthenticationSchema
>;
