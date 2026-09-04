import { z } from 'zod';

export const objectStoreEndpointSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === ''
  );
}, 'must be an HTTP(S) URL without embedded credentials');

export const objectStoreBucketSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u)
  .refine((value) => !value.includes('..'), 'must not contain adjacent dots')
  .refine(
    (value) => !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value),
    'must not be formatted as an IP address',
  );

export const objectStoreForcePathStyleSchema = z
  .enum(['true', 'false'])
  .default('true');

export const objectStoreRequestTimeoutSchema = z.coerce
  .number()
  .int()
  .min(100)
  .max(60_000)
  .default(5_000);
