import {
  createSystemMailClient,
  parseSystemMailConfig,
} from '../../dist/server.js';

// A separate process, like the worker: nodemailer's failure arrives on a socket
// callback, where it kills the process instead of rejecting a promise.
const config = parseSystemMailConfig(process.env, {
  apiKeyName: 'AUTH_MAIL_EMAIL_API_KEY',
  deployed: true,
});
const result = await createSystemMailClient(config).sendNotification({
  fromEmail: 'security@example.test',
  toEmail: 'ada@example.test',
  subject: 'Verify your account',
  text: 'One immutable link',
  idempotencyKey: 'authentication-mail:one',
  timeoutMillis: 5000,
  beforeDispatch: () => Promise.resolve(),
});
console.log(JSON.stringify({ kind: result.kind }));
