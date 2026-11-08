import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('loads the SMTP credential and email executor through the built package entry points', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import { smtpCredentialSchema } from '@pertexo/integrations';
    import { createEmailSendNotificationExecutorRegistration } from '@pertexo/integrations/server';
    const credential = smtpCredentialSchema.safeParse({ type: 'smtp', host: 'relay.example.test', port: 587, security: 'starttls', username: 'ada', password: 'package-fixture', fromEmail: 'alerts@example.test' });
    const registration = createEmailSendNotificationExecutorRegistration({ client: { sendNotification() { throw new Error('No external call permitted'); } } });
    process.stdout.write(JSON.stringify({ smtp: credential.success, executor: registration.executor }));
  `,
    ],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 20_000 },
  );
  expect(JSON.parse(stdout)).toEqual({
    smtp: true,
    executor: { key: 'email.send_notification', version: 1 },
  });
});
