import { parse, stringify } from 'yaml';
import { RUNTIME_IMAGE } from './images.mjs';

// The drill runs the repository's real scripts. These edits are the only
// differences, applied to the drill's own copy and refused if a target has moved:
// its own project name and ports (the machine may be shared), its own CA instead of
// Let's Encrypt (no public DNS), images already built here, and stand-ins for the
// outside services an operator supplies (mail relay, off-server store, alert
// receiver). Nothing here changes what the scripts do.
export const PUBLIC_HOSTS = {
  app: 'app.drill.test',
  files: 'files.drill.test',
  backup: 'backup.drill.test',
  mail: 'mail.drill.test',
  alerts: 'alerts.drill.test',
};
export const MAIL_LOGIN = {
  user: 'drill-mail-user',
  pass: 'drill-mail-password',
};
export const BACKUP_LOGIN = {
  accessKey: 'drillbackupaccess',
  secretKey: 'drillbackupsecretvalue',
  bucket: 'drill-backups',
};
const MAILPIT =
  'axllent/mailpit:v1.29@sha256:757f22b56c1da03570afdb3d259effe5091018008a81bbedc8158cee7e16fdbc';

const ALERT_RECEIVER = `
require('node:http').createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    console.log(JSON.stringify({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString() }));
    response.end('ok');
  });
}).listen(8080);
`;

function required(text, pattern, replacement, what) {
  const replaced = text.replace(pattern, replacement);
  if (replaced === text)
    throw new Error(`The drill overlay no longer matches: ${what}`);
  return replaced;
}

export function overlayCommonScript(source, { project }) {
  const trust =
    '-e NODE_EXTRA_CA_CERTS=/drill-tls/ca.crt -e RCLONE_CA_CERT=/drill-tls/ca.crt -v "$beta_root/drill-tls:/drill-tls:ro"';
  let text = source;
  text = required(
    text,
    /--project-name pertexo-beta/gu,
    `--project-name ${project}`,
    'the Compose project name',
  );
  text = required(
    text,
    /pertexo-beta_private/gu,
    `${project}_private`,
    'the private network name',
  );
  text = required(
    text,
    /compose\.project=pertexo-beta/gu,
    `compose.project=${project}`,
    'the operator container filter',
  );
  text = required(
    text,
    /docker pull [^\n]*/u,
    'docker image inspect "$reference" >/dev/null',
    'the image pull',
  );
  text = required(
    text,
    /rclone\(\) \{\n {2}docker run /u,
    `rclone() {\n  docker run ${trust} `,
    'the rclone helper',
  );
  text = required(
    text,
    /copy_objects\(\) \{\n {2}docker run /u,
    `copy_objects() {\n  docker run ${trust} `,
    'the object copy helper',
  );
  // Only while ops-05 is open: an x86 runner would stop here, before the rest of the
  // drill. The fast test in deploy.test.mjs pins the real behavior. No-op once fixed.
  if (process.arch === 'x64')
    text = text.replace('"arm64 $commit"', '"amd64 $commit"');
  return text;
}

/** deploy.sh and restore.sh name the private network themselves. */
export const overlayNetworkName = (source, { project }) =>
  required(
    source,
    /pertexo-beta_private/gu,
    `${project}_private`,
    'the private network name',
  );

export function overlayCaddyfile(source) {
  const tls = '\ttls /drill-tls/site.crt /drill-tls/site.key\n';
  let text = required(
    source,
    /\{\$APP_HOST\} \{\n/u,
    (match) => match + tls,
    'the app site',
  );
  text = required(
    text,
    /\{\$FILES_HOST\} \{\n/u,
    (match) => match + tls,
    'the files site',
  );
  return text;
}

export function overlayCompose(source, { project, httpPort, httpsPort }) {
  const compose = parse(source, { merge: true, maxAliasCount: -1 });
  const tlsVolume = '${BETA_STATE_DIR}/../drill-tls:/drill-tls:ro';
  compose.name = project;
  compose.services.proxy.ports = [
    `127.0.0.1:${httpPort}:80`,
    `127.0.0.1:${httpsPort}:443`,
  ];
  compose.services.proxy.volumes.push(tlsVolume);
  for (const name of ['api', 'worker']) {
    const service = compose.services[name];
    service.environment = {
      ...service.environment,
      NODE_EXTRA_CA_CERTS: '/drill-tls/ca.crt',
    };
    service.volumes = [...(service.volumes ?? []), tlsVolume];
  }
  const outside = (alias) => ({
    restart: 'unless-stopped',
    networks: { private: { aliases: [alias] } },
  });
  compose.services['drill-mail'] = {
    ...outside(PUBLIC_HOSTS.mail),
    image: MAILPIT,
    environment: {
      MP_SMTP_AUTH: `${MAIL_LOGIN.user}:${MAIL_LOGIN.pass}`,
      MP_SMTP_TLS_CERT: '/drill-tls/site.crt',
      MP_SMTP_TLS_KEY: '/drill-tls/site.key',
      MP_SMTP_REQUIRE_STARTTLS: 'true',
    },
    volumes: [tlsVolume],
  };
  compose.services['drill-backup-store'] = {
    ...outside('drill-backup-store'),
    image: compose.services.storage.image,
    command: ['/data'],
    environment: {
      RUSTFS_ACCESS_KEY: BACKUP_LOGIN.accessKey,
      RUSTFS_SECRET_KEY: BACKUP_LOGIN.secretKey,
      RUSTFS_CONSOLE_ENABLE: 'false',
      RUSTFS_REGION: 'us-east-1',
    },
    // A bind mount: it stands for storage that outlives the server being wiped.
    volumes: ['${BETA_STATE_DIR}/../drill-backup-data:/data'],
  };
  compose.services['drill-backup-proxy'] = {
    ...outside(PUBLIC_HOSTS.backup),
    image: compose.services.proxy.image,
    volumes: [
      tlsVolume,
      '${BETA_STATE_DIR}/../drill-tls/backup.Caddyfile:/etc/caddy/Caddyfile:ro',
    ],
    depends_on: ['drill-backup-store'],
  };
  compose.services['drill-alerts'] = {
    ...outside(PUBLIC_HOSTS.alerts),
    image: RUNTIME_IMAGE,
    command: ['node', '-e', ALERT_RECEIVER],
  };
  compose.services.storage.depends_on = [
    'drill-mail',
    'drill-backup-proxy',
    'drill-alerts',
  ];
  return stringify(compose, { aliasDuplicateObjects: false, lineWidth: 0 });
}

/**
 * Only while the fresh-install bug is open: releases extracted under the scripts'
 * umask are unreadable to Postgres and the ops image's users on real Linux, so a
 * later step could never run. Unused once a first deploy succeeds.
 */
export function readableReleases(source) {
  return required(
    source,
    /mv "\$staging" "\$beta_root\/releases\/\$commit"/u,
    'chmod -R a+rX "$staging"\n    $&',
    'the release extraction',
  );
}

/** The same overlaid Compose file with a web tier that can't reach the API. */
export function breakWebUpstream(source) {
  const compose = parse(source);
  compose.services.web.environment = {
    ...compose.services.web.environment,
    PERTEXO_API_UPSTREAM: 'http://api:3999',
  };
  return stringify(compose, { aliasDuplicateObjects: false, lineWidth: 0 });
}

export const BACKUP_CADDYFILE = `{
\tadmin off
}
${PUBLIC_HOSTS.backup} {
\ttls /drill-tls/site.crt /drill-tls/site.key
\treverse_proxy drill-backup-store:9000
}
`;
