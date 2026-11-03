import { expect, it } from 'vitest';

import { parseMigrationConfig } from '../../../src/config.js';
import { runMigrationCli } from '../../../src/migrate.js';

it.each([
  ['DATABASE_MIGRATION_URL', undefined, 'string'],
  ['DATABASE_MIGRATION_URL', 'private-invalid-url', 'URL'],
  [
    'DATABASE_MIGRATION_URL',
    'https://private-user:private-password@private-host/database',
    'postgresql://',
  ],
  ['POSTGRES_OWNER_USER', 'private-owner!role', 'pattern'],
  ['POSTGRES_APP_USER', 'private-app!role', 'pattern'],
  ['POSTGRES_MAINTENANCE_USER', 'private-maintenance!role', 'pattern'],
])(
  'names a bad %s setting and its remedy without echoing its value',
  async (setting, value, remedy) => {
    let error = '',
      output = '';
    expect(
      await runMigrationCli({
        loadConfig: () =>
          parseMigrationConfig({
            DATABASE_MIGRATION_URL:
              'postgresql://private-user:private-password@private-host/database',
            [setting]: value,
          }),
        writeError: (text) => {
          error += text;
        },
        writeOutput: (text) => {
          output += text;
        },
      }),
    ).toBe(1);
    expect(error).toContain(setting);
    expect(error).toContain(remedy);
    expect(output).toBe('');
    for (const secret of [
      'private-user',
      'private-password',
      'private-host',
      value,
    ])
      if (secret !== undefined) expect(error).not.toContain(secret);
  },
);
