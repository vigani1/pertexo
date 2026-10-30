import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  codeContainerLimits,
  parseCodeSettings,
} from '../../../packages/node-sdk/dist/index.js';
import { parseApiConfig } from '../../../apps/api/dist/platform/config/api.js';
import { it } from './support/it.mjs';

// What a stranger reads and relies on. These check claims against the real scripts
// wherever a claim can be checked. A person following the page on a new server is
// still the last proof: see "Not provable here" in the batch notes.
const runbookPath = 'docs/operations/single-server.md';
const runbook = () => readFileSync(runbookPath, 'utf8');
const operationsPages = () =>
  readdirSync('docs/operations')
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/operations/${name}`);

const headings = (markdown) =>
  markdown
    .split('\n')
    .map((line) => /^#{1,4} (.+)$/u.exec(line)?.[1])
    .filter(Boolean);
const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[`*]/gu, '')
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .replace(/\s/gu, '-');
/** The text under the first heading that matches, up to the next heading of its rank. */
function section(markdown, pattern) {
  const lines = markdown.split('\n');
  const start = lines.findIndex(
    (line) => /^#{1,4} /u.test(line) && pattern.test(line),
  );
  if (start < 0) return undefined;
  const rank = /^#+/u.exec(lines[start])[0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const match = /^(#{1,4}) /u.exec(line);
    return match && match[1].length <= rank;
  });
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

function brokenLinks(path) {
  const markdown = readFileSync(path, 'utf8').replace(/```[\s\S]*?```/gu, '');
  const broken = [];
  for (const [, target] of markdown.matchAll(/\]\(([^)\s]+)\)/gu)) {
    if (/^[a-z]+:/iu.test(target)) continue;
    const [file, anchor] = target.split('#');
    const resolved = file ? resolve(dirname(path), file) : resolve(path);
    if (!existsSync(resolved)) broken.push(target);
    else if (anchor && resolved.endsWith('.md')) {
      const known = headings(readFileSync(resolved, 'utf8')).map(slug);
      if (!known.includes(anchor)) broken.push(target);
    }
  }
  return broken;
}

test('every link in the operations pages, guides and README resolves', () => {
  const guides = readdirSync('docs/guides')
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/guides/${name}`);
  for (const path of [...operationsPages(), ...guides, 'README.md'])
    assert.deepEqual(brokenLinks(path), [], path);
});

// ops-05, docs-deps-product-05: the owner can't use Oracle, and nor can most people.
it('assumes no cloud provider or processor anywhere an operator reads', () => {
  const pages = [
    ...operationsPages(),
    'README.md',
    'infrastructure/single-server/.env.production.example',
    'infrastructure/single-server/compose.yaml',
    'docs/feature-plans/single-server-beta.md',
  ];
  for (const path of pages)
    assert.doesNotMatch(
      readFileSync(path, 'utf8'),
      /\bOracle\b|oraclecloud|\bAmpere\b|\bVCN\b|Always Free/u,
      path,
    );
  assert.doesNotMatch(runbook(), /Ubuntu 24\.04 ARM|`aarch64`/u);
  assert.match(runbook(), /x86[-_ ]64|amd64/iu);
  assert.match(runbook(), /arm64|aarch64/iu);
  assert.match(runbook(), /any S3-compatible/iu);
});

// ops-05, docs-deps-product-05
it('ADR 071 records that the beta runs on any Linux server', () => {
  const adr = readFileSync('docs/adr/071-single-server-beta.md', 'utf8');
  assert.match(adr, /any (Linux|Ubuntu) server/iu);
  assert.match(adr, /multi-architecture|x86/iu);
  assert.doesNotMatch(adr, /Uptime alerts are outside this plan/u);
});

// ops-06: 489 lines mixing install, operations and design rationale.
it('speaks to a stranger, not to the people who built it', () => {
  assert.doesNotMatch(
    runbook(),
    /Implementation is in progress|slice 6|owner-assisted|the owner's|existing operator runbooks|This plan adds no/u,
  );
});

// ops-06
it('gives the install as one straight line, ahead of everything else', () => {
  const list = headings(runbook());
  const positions = [
    /server/iu,
    /DNS/u,
    /configure/iu,
    /deploy|install/iu,
    /first (account|user)/iu,
    /smoke|check it works|verify the install/iu,
    /backup/iu,
  ].map((pattern) => list.findIndex((heading) => pattern.test(heading)));
  assert.ok(
    positions.every((position) => position >= 0),
    String(positions),
  );
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
  );
  // Deep detail comes after the first account, or on its own page.
  const firstAccount = positions[4];
  for (const later of [
    /scratch/iu,
    /rotat/iu,
    /code runner/iu,
    /single sign|sign-in provider/iu,
  ]) {
    const position = list.findIndex((heading) => later.test(heading));
    assert.ok(position < 0 || position > firstAccount, String(later));
  }
});

// ops-06, ops-16: no size stated anywhere; the Code runner's own ceiling is 2,912 MiB.
it('states a server size that fits what the stack actually reserves', () => {
  const sizing = section(runbook(), /siz|server/iu) ?? '';
  const cpus = /(\d+)\s*(?:v?CPUs?|cores?)/iu.exec(sizing);
  const memory =
    /(\d+)\s*GB[^.\n]*?(?:RAM|memory)|(?:RAM|memory)[^.\n]*?(\d+)\s*GB/iu.exec(
      sizing,
    );
  const disk = /(\d+)\s*GB[^.\n]*?disk|disk[^.\n]*?(\d+)\s*GB/iu.exec(sizing);
  assert.ok(cpus, 'a CPU count');
  assert.ok(memory, 'a memory size');
  assert.ok(disk, 'a disk size');
  const environment = {
    CODE_STEPS_ENABLED: 'true',
    CODE_RUNNER_MEMORY_MB: '128',
    CODE_RUNNER_MAX_SECONDS: '30',
    CODE_RUNNER_CONCURRENCY: '2',
  };
  const example = readFileSync(
    'infrastructure/single-server/.env.production.example',
    'utf8',
  );
  for (const [name] of Object.entries(environment))
    assert.ok(example.includes(`${name}=${environment[name]}`), name);
  const codeCeiling = codeContainerLimits(
    parseCodeSettings(environment),
  ).memoryMiB;
  // About 1 GB is what the other services used idle in the audit's drill.
  assert.ok(
    Number(memory[1] ?? memory[2]) * 1024 >= codeCeiling + 1024,
    `${memory[0]} leaves no room for ${codeCeiling} MiB of Code runner`,
  );
});

// ops-06: nothing said what to open or how to get the first account in.
it('walks through getting the first account in', () => {
  const first = section(runbook(), /first (account|user)/iu);
  assert.ok(first);
  assert.match(first, /https:\/\/<?app/iu);
  assert.match(first, /sign up|sign-up/iu);
  assert.match(first, /verif/iu);
});

// ops-06: "Run it with the pinned runtime image" gave no command, and a fresh server has no Node.
it('gives a secrets command that works on a server with only Docker', () => {
  const blocks = [...runbook().matchAll(/```(?:sh|bash)\n([\s\S]*?)```/gu)].map(
    (match) => match[1],
  );
  const command = blocks.find((block) =>
    block.includes('generate-secrets.mjs'),
  );
  assert.ok(command, 'a shell block running the generator');
  assert.match(command, /docker run/u);
  assert.doesNotMatch(command, /^\s*node /mu);
  assert.doesNotMatch(command, /--encryption=kms/u);
  assert.doesNotMatch(
    readFileSync(
      'infrastructure/single-server/.env.production.example',
      'utf8',
    ),
    /defaults to kms/iu,
  );
});

// ops-06
it('has somewhere to look when something goes wrong later', () => {
  const all = operationsPages()
    .map((path) => headings(readFileSync(path, 'utf8')).join('\n'))
    .join('\n');
  for (const pattern of [/monitoring|alerts/iu, /upgrad/iu, /troubleshoot/iu])
    assert.match(all, pattern);
  assert.ok(runbook().includes('operator-commands.md'));
});

// ops-07
it('tells the operator how to turn alerts on', () => {
  const page = operationsPages()
    .map((path) => section(readFileSync(path, 'utf8'), /monitoring|alerts/iu))
    .find((text) => text?.includes('ALERT_WEBHOOK_URL'));
  assert.ok(page, 'a monitoring section naming ALERT_WEBHOOK_URL');
  assert.match(page, /BACKUP_HEARTBEAT_URL/u);
  assert.match(page, /check\.timer|pertexo-check/u);
  assert.match(page, /disk/iu);
  assert.match(page, /stuck/iu);
  assert.match(page, /\/health\/ready|readiness/iu);
  const example = readFileSync(
    'infrastructure/single-server/.env.production.example',
    'utf8',
  );
  assert.match(example, /ALERT_WEBHOOK_URL/u);
  assert.match(example, /BACKUP_HEARTBEAT_URL/u);
});

// ops-07
it('runs the health check on a timer', () => {
  const service = readFileSync(
    'infrastructure/single-server/systemd/check.service',
    'utf8',
  );
  const timer = readFileSync(
    'infrastructure/single-server/systemd/check.timer',
    'utf8',
  );
  assert.match(service, /ExecStart=.*\/check\.sh/u);
  assert.match(service, /User=pertexo/u);
  assert.match(timer, /OnCalendar=|OnUnitActiveSec=/u);
  assert.match(timer, /Persistent=true/u);
});

function actualRetentionDays(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-retention-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const listing = join(directory, 'points');
  // Half-day ages, so no point sits on the boundary while this runs.
  const pointFor = (days) => {
    const date = new Date(Date.now() - days * 86_400_000);
    return `${date.toISOString().replace(/[-:]/gu, '').slice(0, 15)}Z`;
  };
  writeFileSync(
    listing,
    Array.from(
      { length: 60 },
      (_, day) => `pertexo-beta/${pointFor(day + 0.5)}/\n`,
    ).join(''),
  );
  const expired = execFileSync(
    process.execPath,
    [
      'infrastructure/single-server/backup/recovery-points.mjs',
      'expired',
      listing,
    ],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
  return 60 - expired.length;
}

test('the runbook states the retention the backup scripts actually apply', (t) => {
  const days = actualRetentionDays(t);
  const recovery = operationsPages()
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  assert.match(recovery, new RegExp(`older than ${days} days`, 'u'));
});

// docs-deps-product-16: the policy promises encrypted backups for 35 days, the scripts
// keep them unencrypted for 14. Whatever the scripts do is what the policy must say.
it('the data policy promises the retention and protection backups really have', (t) => {
  const days = actualRetentionDays(t);
  const policy = readFileSync(
    'docs/operations/production-data-policy.md',
    'utf8',
  );
  const row = policy
    .split('\n')
    .find((line) => line.startsWith('|') && /backup/iu.test(line));
  assert.ok(row, 'a retention row for backups');
  assert.match(row, new RegExp(`\\b${days} days\\b`, 'u'));
  assert.doesNotMatch(policy, /\b35 days\b/u);
  assert.doesNotMatch(policy, /cross-region copies|WAL archives/u);
  const scriptsEncrypt = /\bage\b|gpg|--encrypt|openssl enc/u.test(
    readFileSync('infrastructure/single-server/backup.sh', 'utf8'),
  );
  if (!scriptsEncrypt) assert.doesNotMatch(row, /encrypted/iu);
  assert.doesNotMatch(policy, /operated launch inputs/u);
});

// docs-deps-product-15: the runbook points at operator runbooks that don't exist.
it('no page points at runbooks that are not there', () => {
  for (const path of [runbookPath, 'docs/guides/two-factor-sign-in.md']) {
    assert.doesNotMatch(
      readFileSync(path, 'utf8'),
      /existing operator runbooks/u,
      path,
    );
    assert.equal(
      /operator-commands\.md/u.test(readFileSync(path, 'utf8')),
      true,
      path,
    );
  }
  assert.doesNotMatch(
    runbook(),
    /No new reconciliation UI or command\s+is included/u,
  );
});

test('the example environment is valid for the deployed parser with self-managed keys', () => {
  const parsed = parseApiConfig({
    ...Object.fromEntries(
      readFileSync(
        'infrastructure/single-server/.env.production.example',
        'utf8',
      )
        .split('\n')
        .filter((line) => !line.startsWith('#') && line.includes('='))
        .map((line) => [
          line.slice(0, line.indexOf('=')),
          line.slice(line.indexOf('=') + 1),
        ]),
    ),
    ...Object.fromEntries(
      execFileSync(
        process.execPath,
        [
          'infrastructure/single-server/generate-secrets.mjs',
          '--encryption=self-managed',
        ],
        { encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .map((line) => {
          const split = line.indexOf('=');
          return [line.slice(0, split), line.slice(split + 2, -1)];
        }),
    ),
    PUBLIC_WEB_ORIGIN: 'https://app.example.test',
    ARTIFACT_STORE_ENDPOINT: 'https://files.example.test',
    AUTH_MAIL_FROM: 'security@example.test',
    AUTH_MAIL_EMAIL_API_KEY: 'fixture',
    INVITATION_EMAIL_FROM: 'invites@example.test',
    INVITATION_EMAIL_API_KEY: 'fixture',
  });
  assert.equal(parsed.connections.mode, 'self-managed');
});
