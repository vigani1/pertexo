import {
  POSTGRES_DEFAULT_PORT,
  postgresCredentialSchema,
} from '@pertexo/contracts';
import { z } from 'zod';
import type { ConnectionDefinition } from '../providers/connection-definition.js';
import { labelledChoice } from '@pertexo/node-sdk';

const postgresFields = {
  host: postgresCredentialSchema
    .unwrap()
    .shape.host.meta({ type: 'string', title: 'Host', trim: true }),
  port: postgresCredentialSchema.unwrap().shape.port.meta({
    title: 'Port',
    default: POSTGRES_DEFAULT_PORT,
    numericInput: true,
  }),
  database: postgresCredentialSchema
    .unwrap()
    .shape.database.meta({ title: 'Database' }),
  user: postgresCredentialSchema.unwrap().shape.user.meta({ title: 'User' }),
  password: postgresCredentialSchema
    .unwrap()
    .shape.password.meta({ title: 'Password', secret: true }),
  tls: labelledChoice({
    require: 'Require',
    'verify-full': 'Verify full',
    disable: 'Disable',
  }).meta({
    title: 'TLS mode',
    notice: 'postgres_plaintext',
    default: 'require',
  }),
  ca: postgresCredentialSchema.unwrap().shape.ca.meta({
    title: 'CA certificate (optional)',
    multiline: true,
    omitEmpty: true,
    visibleWhen: { field: 'tls', value: 'verify-full' },
  }),
  readOnly: postgresCredentialSchema
    .unwrap()
    .shape.readOnly.meta({ title: 'Read-only connection', default: false }),
};

export const POSTGRES_CONNECTION = {
  authType: 'postgres',
  presentation: {
    requirement: 'PostgreSQL connection',
    choice: 'postgres',
    pickerOrder: 0,
    name: 'PostgreSQL',
    purpose: 'Query a database and write rows',
    credential: 'database login',
    savedCredential: 'database login',
    usedBy: 'Database steps',
    nameSuffix: 'PostgreSQL',
  },
  schema: postgresCredentialSchema
    .unwrap()
    .safeExtend(postgresFields)
    .readonly(),
  fields: z.strictObject(postgresFields),
  auth: { kind: 'postgres' },
  test: { kind: 'postgres' },
  slot: { key: 'postgres', primary: true },
} as const satisfies ConnectionDefinition;
