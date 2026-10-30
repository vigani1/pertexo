import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { it } from './support/it.mjs';

// The fast half of the quick try: what the page promises and what the file allows.
// test/drill/quickstart.test.mjs runs the documented command for real.
const composePath = 'infrastructure/quickstart/compose.yaml';
const section = () => {
  const readme = readFileSync('README.md', 'utf8');
  const start = readme.search(/^## .*(try|quick)/imu);
  assert.ok(start >= 0, 'a README section for the quick try');
  const rest = readme.slice(start);
  const end = rest.indexOf('\n## ', 1);
  return end < 0 ? rest : rest.slice(0, end);
};

// ops-10, docs-deps-product-06: n8n's is one docker run; ours took an evening.
it.fails('documents one command and says it is not for production', () => {
  const text = section();
  assert.match(text, /not for production/iu);
  const blocks = [...text.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/gu)];
  assert.equal(blocks.length, 1, 'one command block');
  const lines = blocks[0][1].trim().split('\n');
  assert.equal(lines.length, 1, 'one command');
  assert.match(
    lines[0],
    /^docker compose -f infrastructure\/quickstart\/compose\.yaml up -d --wait$/u,
  );
  // No setup a person trying it out would have to do.
  assert.doesNotMatch(text, /SMTP|\.env\.production|generate-secrets/u);
});

// ops-10: a demo on a public address is an open invitation.
it.fails('labels itself and listens only on this machine', () => {
  assert.match(readFileSync(composePath, 'utf8'), /not for production/iu);
  const config = JSON.parse(
    execFileSync(
      'docker',
      ['compose', '-f', composePath, 'config', '--format', 'json'],
      { encoding: 'utf8' },
    ),
  );
  const published = Object.values(config.services).flatMap(
    (service) => service.ports ?? [],
  );
  assert.equal(published.length, 1, 'one published address');
  assert.equal(published[0].host_ip, '127.0.0.1');
});

// docs-deps-product-06: a required mail account and two hostnames are the real cost.
it.fails('needs no settings file, mail account or second hostname', () => {
  const text = readFileSync(composePath, 'utf8');
  assert.doesNotMatch(text, /:\?/u);
  assert.doesNotMatch(text, /env_file/u);
  assert.doesNotMatch(text, /SYSTEM_MAIL_SMTP|EMAIL_API_KEY/u);
});
