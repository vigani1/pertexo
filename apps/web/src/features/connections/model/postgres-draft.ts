import {
  POSTGRES_DEFAULT_PORT,
  postgresCredentialSchema,
  type PostgresCredential,
} from '@pertexo/contracts';

export type PostgresDraft = Readonly<{
  provider: 'postgres';
  host: string;
  port: string;
  user: string;
  database: string;
  password: string;
  tls: PostgresCredential['tls'];
  ca: string;
  readOnly: boolean;
}>;

export const POSTGRES_FIELDS = [
  'host',
  'port',
  'user',
  'database',
  'password',
  'tls',
  'ca',
  'readOnly',
] as const;
export type PostgresField = (typeof POSTGRES_FIELDS)[number];

export function emptyPostgresDraft(): PostgresDraft {
  return {
    provider: 'postgres',
    host: '',
    port: String(POSTGRES_DEFAULT_PORT),
    user: '',
    database: '',
    password: '',
    tls: 'require',
    ca: '',
    readOnly: false,
  };
}

export function postgresCredential(draft: PostgresDraft): PostgresCredential {
  return {
    type: 'postgres',
    host: draft.host.trim(),
    port: Number(draft.port),
    user: draft.user,
    database: draft.database,
    password: draft.password,
    tls: draft.tls,
    readOnly: draft.readOnly,
    ...(draft.tls === 'verify-full' && draft.ca.trim() !== ''
      ? { ca: draft.ca }
      : {}),
  };
}

export function postgresDraftErrors(
  draft: PostgresDraft,
): Partial<Record<PostgresField, string>> {
  const parsed = postgresCredentialSchema.safeParse(postgresCredential(draft));
  if (parsed.success) return {};
  const errors: Partial<Record<PostgresField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = POSTGRES_FIELDS.find(
      (candidate) => candidate === issue.path[0],
    );
    if (field !== undefined) errors[field] = issue.message;
  }
  return errors;
}
