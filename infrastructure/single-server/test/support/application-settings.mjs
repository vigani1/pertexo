import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const applicationSettings =
  readFileSync('infrastructure/single-server/.env.production.example', 'utf8') +
  '\n' +
  execFileSync(
    process.execPath,
    [
      'infrastructure/single-server/generate-secrets.mjs',
      '--encryption=self-managed',
    ],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((line) => !line.startsWith('BACKUP_CRYPT_'))
    .join('\n') +
  '\nPUBLIC_WEB_ORIGIN=https://app.example.test\nARTIFACT_STORE_ENDPOINT=https://files.example.test\nAUTH_MAIL_FROM=auth@example.test\nINVITATION_EMAIL_FROM=invite@example.test\nAUTH_MAIL_EMAIL_API_KEY=fixture-key\nINVITATION_EMAIL_API_KEY=fixture-key\n';
