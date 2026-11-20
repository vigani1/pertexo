import { z } from 'zod';

export const POSTGRES_DEFAULT_PORT = 5432;
const POSTGRES_CREDENTIAL_BOUNDS = Object.freeze({
  portMaximum: 65535,
  hostCharacters: 253,
  nameCharacters: 1024,
  passwordCharacters: 4096,
  certificateCharacters: 32768,
});

const name = z
  .string()
  .min(1)
  .max(POSTGRES_CREDENTIAL_BOUNDS.nameCharacters)
  .regex(/^[^\0]+$/u);

export const postgresCredentialSchema = z
  .strictObject({
    type: z.literal('postgres'),
    host: z.union([
      z.ipv4(),
      z.ipv6(),
      z.hostname().max(POSTGRES_CREDENTIAL_BOUNDS.hostCharacters),
    ]),
    port: z.number().int().min(1).max(POSTGRES_CREDENTIAL_BOUNDS.portMaximum),
    database: name,
    user: name,
    password: z
      .string()
      .min(1)
      .max(POSTGRES_CREDENTIAL_BOUNDS.passwordCharacters)
      .regex(/^[^\0]+$/u),
    tls: z.enum(['require', 'verify-full', 'disable']),
    ca: z
      .string()
      .min(1)
      .max(POSTGRES_CREDENTIAL_BOUNDS.certificateCharacters)
      .optional(),
    readOnly: z.boolean().optional(),
  })
  .refine(
    (credential) =>
      credential.ca === undefined || credential.tls === 'verify-full',
    {
      path: ['ca'],
      message: 'A CA certificate requires Verify full TLS.',
    },
  )
  .readonly();

export type PostgresCredential = z.output<typeof postgresCredentialSchema>;

export const POSTGRES_LIMITS = Object.freeze({
  defaultTimeoutMillis: 10_000,
  maxTimeoutMillis: 60_000,
  defaultRows: 100,
  maxRows: 1_000,
  resultBytes: 131_072,
});

export const POSTGRES_FAILURE_CODES = [
  'address_blocked',
  'tls_failed',
  'connection_refused',
  'connection_failed',
  'authentication_failed',
  'timeout',
  'syntax_error',
  'constraint_violation',
  'read_only',
  'serialization',
  'query_failed',
  'row_limit',
  'result_limit',
  'invalid_columns',
  'canceled',
] as const;

export type PostgresFailureCode = (typeof POSTGRES_FAILURE_CODES)[number];
