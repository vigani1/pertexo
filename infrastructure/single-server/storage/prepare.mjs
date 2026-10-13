import { writeFile, chmod } from 'node:fs/promises';
import { requireCompatibleRelease } from '../encryption/require-compatible-release.mjs';
import { parseApiConfig } from '../../../apps/api/dist/platform/config/api.js';
import { parseWorkerConfig } from '../../../apps/worker/dist/config/worker.js';
import { parseMigrationConfig } from '../../../packages/database/dist/config.js';

// Use the application boundaries; configuration errors must fail before stopping a release.
const environment = {
  ...process.env,
  WORKER_INSTANCE_ID: 'deployment-validation',
};
const apiConfig = parseApiConfig(environment);
parseWorkerConfig(environment);
parseMigrationConfig(environment);
if (
  environment.NODE_ENV !== 'production' ||
  environment.AUTH_MAIL_MODE !== 'durable' ||
  environment.SESSION_COOKIE_SECURE !== 'true'
) {
  throw new Error(
    'The beta requires production, durable mail and secure cookies',
  );
}
function host(name) {
  const url = new URL(environment[name]);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !/^[a-z0-9.-]+$/u.test(url.hostname)
  )
    throw new Error(`${name} must be an HTTPS origin on port 443`);
  return url.hostname;
}
const app = host('PUBLIC_WEB_ORIGIN');
const files = host('ARTIFACT_STORE_ENDPOINT');
if (app === files) throw new Error('The app and files need distinct hosts');
if (environment.ARTIFACT_STORE_FORCE_PATH_STYLE !== 'true')
  throw new Error('Path-style S3 access is required');
for (const name of [
  'STORAGE_ADMIN_ACCESS_KEY_ID',
  'STORAGE_ADMIN_SECRET_ACCESS_KEY',
]) {
  if (!environment[name]) throw new Error(`${name} is required`);
}
const connectionEncryption = apiConfig.connections;
requireCompatibleRelease(connectionEncryption, process.argv[3]);
const encryptionEnvironment =
  'mode' in connectionEncryption
    ? {
        CONNECTION_ENCRYPTION_MODE: connectionEncryption.mode,
        CONNECTION_SELF_MANAGED_KEY:
          connectionEncryption.encryption.current.key,
        CONNECTION_SELF_MANAGED_KEY_VERSION:
          connectionEncryption.encryption.current.version,
        ...(connectionEncryption.encryption.previous.length
          ? {
              CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: JSON.stringify(
                connectionEncryption.encryption.previous,
              ),
            }
          : {}),
      }
    : {
        CONNECTION_ENCRYPTION_MODE: 'kms',
        CONNECTION_KMS_KEY_REFERENCE: connectionEncryption.kmsKeyReference,
        CONNECTION_KMS_REGION: connectionEncryption.region,
        ...(connectionEncryption.endpoint === undefined
          ? {}
          : { CONNECTION_KMS_ENDPOINT: connectionEncryption.endpoint }),
        ...Object.fromEntries(
          [
            'AWS_ACCESS_KEY_ID',
            'AWS_SECRET_ACCESS_KEY',
            'AWS_SESSION_TOKEN',
            'AWS_PROFILE',
            'AWS_SHARED_CREDENTIALS_FILE',
            'AWS_CONFIG_FILE',
          ]
            .filter((name) => environment[name])
            .map((name) => [name, environment[name]]),
        ),
      };
const directory = process.argv[2];
if (!directory) throw new Error('A private output directory is required');
const output = async (name, value) => {
  const path = directory + '/' + name;
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
};
const admin = new URL('http://storage:9000');
admin.username = environment.STORAGE_ADMIN_ACCESS_KEY_ID;
admin.password = environment.STORAGE_ADMIN_SECRET_ACCESS_KEY;
await output(
  'rc.env',
  [
    `RC_HOST_internal=${admin.href}`,
    'RC_CONFIG_DIR=/tmp/rc',
    ...[
      'ARTIFACT_STORE_BUCKET',
      'ARTIFACT_STORE_ACCESS_KEY_ID',
      'ARTIFACT_STORE_SECRET_ACCESS_KEY',
    ].map((name) => {
      if (/[\r\n]/u.test(environment[name]))
        throw new Error(`${name} must fit on one line`);
      return `${name}=${environment[name]}`;
    }),
  ].join('\n') + '\n',
);
await output(
  'policy.json',
  JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          's3:GetBucketLocation',
          's3:ListBucket',
          's3:ListBucketVersions',
        ],
        Resource: [`arn:aws:s3:::${environment.ARTIFACT_STORE_BUCKET}`],
      },
      {
        Effect: 'Allow',
        Action: [
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:DeleteObjectVersion',
        ],
        Resource: [`arn:aws:s3:::${environment.ARTIFACT_STORE_BUCKET}/*`],
      },
    ],
  }),
);
await output(
  'cors.json',
  JSON.stringify({
    rules: [
      {
        allowedOrigins: [environment.PUBLIC_WEB_ORIGIN],
        allowedMethods: ['GET', 'PUT', 'HEAD'],
        allowedHeaders: ['*'],
        exposeHeaders: ['ETag'],
        maxAgeSeconds: 300,
      },
    ],
  }),
);
await output('hosts.env', `APP_HOST=${app}\nFILES_HOST=${files}\n`);

function optionalValues(names, source = environment) {
  return names
    .filter((name) => source[name])
    .map((name) => {
      const value = source[name];
      if (/[\r\n]/u.test(value))
        throw new Error(`${name} must fit on one line`);
      return `${name}='${value.replaceAll("'", "\\'")}'\n`;
    })
    .join('');
}
const encryptionLines = optionalValues(
  Object.keys(encryptionEnvironment),
  encryptionEnvironment,
);
await output(
  'encryption.env',
  encryptionLines + optionalValues(['NODE_ENV', 'DATABASE_MAINTENANCE_URL']),
);
const previous = ['AUTH_MAIL_PREVIOUS_KEYS', 'INVITATION_TOKEN_PREVIOUS_KEYS'];
const providers = ['GOOGLE', 'GITHUB', 'MICROSOFT', 'APPLE'].flatMap(
  (provider) => [
    `AUTH_${provider}_CLIENT_ID`,
    `AUTH_${provider}_CLIENT_SECRET`,
  ],
);
await output(
  'api.env',
  optionalValues([...previous, ...providers, 'AUTH_MICROSOFT_TENANT_ID']) +
    encryptionLines,
);
await output('worker.env', optionalValues(previous) + encryptionLines);
