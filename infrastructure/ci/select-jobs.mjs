import { selectBrowserReach } from '../testing/browser-reach.mjs';
import { recordedMockedShards } from '../testing/mocked-shards.mjs';
import { assignDurationShards } from '../testing/duration-shards.mjs';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The selector owns job coverage; the workflow consumes its matrices.
export const unitGroups = {
  core: [
    'contracts',
    'core',
    'integrations',
    'node-catalog',
    'node-sdk',
    'nodes-core',
    'observability',
    'queue',
    'rate-limit',
    'secrets',
    'templates',
    'workflow-engine',
    'workflow-model',
    'policy',
    'artifact-store',
    'database',
  ],
  apps: ['api', 'worker', 'ops', 'cli', 'code-runner'],
  web: ['web'],
};
const integrationGroups = {
  database: ['database', 'secrets', 'core'],
  core: ['core'],
  services: ['artifact-store', 'queue', 'ops', 'api', 'worker'],
  worker: ['worker'],
};
const liveDurations = JSON.parse(
  readFileSync(
    new URL('../testing/live-durations.json', import.meta.url),
    'utf8',
  ),
);
const mockedDurations = JSON.parse(
  readFileSync(
    new URL('../testing/mocked-durations.json', import.meta.url),
    'utf8',
  ),
);
// Read the scenario catalog so adding a journey also puts it in CI.
const editorScenarios = readFileSync(
  new URL(
    '../../apps/api/test/browser/editor/fixture/environment.ts',
    import.meta.url,
  ),
  'utf8',
);
const journeys = [
  ...[...editorScenarios.matchAll(/^ {4}'([a-z0-9-]+)',$/gmu)].map(
    ([, name]) => name,
  ),
  'usage',
  'security',
  'organization-saml',
  'workflow-concurrency',
  'connection-health',
  'oauth2',
  'workflow-organization',
];
const fullMockedShards = recordedMockedShards();
export const browserEntries = [
  ...fullMockedShards.map(({ milliseconds }, index) => ({
    suite: `mocked-${index + 1}`,
    journeys: '',
    shard: `${index + 1}/${fullMockedShards.length}`,
    milliseconds,
  })),
  ...liveBrowserEntries(journeys, 3),
];
// Fault tests stop real services and take about 15 minutes on four runners, so
// a pull request runs them only when it changes those tests, their tooling or
// the services they stop. Pushes and the schedule always run them.
const FAULT_PATHS =
  /^apps\/worker\/test\/(recovery|support\/recovery)\/|^apps\/worker\/vitest\.resilience\.config\.ts$|^infrastructure\/testing\/(run-fault-shard|fault-project|fault-durations|test-stack)[^/]*$|^\.github\/(workflows\/ci\.yml|actions\/(start-services|setup|docker-mirror)\/)|^compose\.yaml$|^infrastructure\/(postgres|redis|images)\//u;
const liveWorkspaces = ['web', 'api', 'worker', 'cli', 'ops', 'code-runner'];

export function readWorkspaces(root = '.') {
  return ['apps', 'packages'].flatMap((area) =>
    readdirSync(join(root, area), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const path = `${area}/${entry.name}`;
        const manifest = JSON.parse(
          readFileSync(join(root, path, 'package.json'), 'utf8'),
        );
        return {
          path,
          name: manifest.name,
          dependencies: Object.entries({
            ...manifest.dependencies,
            ...manifest.devDependencies,
          })
            .filter(([, version]) => version.startsWith('workspace:'))
            .map(([name]) => name),
        };
      }),
  );
}

export function selectJobs(files, workspaces, event = 'pull_request') {
  const mapped = new Set(
    Object.values(unitGroups)
      .flat()
      .map((name) => `@pertexo/${name}`),
  );
  for (const { name } of workspaces)
    if (!mapped.has(name))
      throw new Error(`Workspace ${name} has no CI job mapping`);
  const affected = new Set();
  let all = event !== 'pull_request';
  for (const file of files) {
    // Shared configuration takes precedence over documentation extensions.
    if (file.startsWith('.github/')) {
      all = true;
      continue;
    }
    if (file.startsWith('docs/') || file.endsWith('.md')) continue;
    const workspace = workspaces.find(({ path }) =>
      file.startsWith(`${path}/`),
    );
    if (workspace) affected.add(workspace.name);
    else all = true;
  }
  if (all) for (const { name } of workspaces) affected.add(name);
  // Walk reverse edges to a fixed point, including devDependencies used by tests.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const workspace of workspaces) {
      if (
        !affected.has(workspace.name) &&
        workspace.dependencies.some((name) => affected.has(name))
      ) {
        affected.add(workspace.name);
        expanded = true;
      }
    }
  }
  const reaches = (names) =>
    names.some((name) => affected.has(`@pertexo/${name}`));
  const code = all || affected.size > 0;
  // Deployment checks read built packages from most workspaces and the docs
  // runbooks, so like the static checks they run for every change.
  const check = ['static', 'deploy'];
  if (reaches(['web'])) check.push('lint-web');
  if (all || [...affected].some((name) => name !== '@pertexo/web'))
    check.push('lint-rest');
  const selectedBrowser = all
    ? undefined
    : selectBrowserReach(
        files.filter(
          (file) => !file.startsWith('docs/') && !file.endsWith('.md'),
        ),
      );
  return {
    code,
    faults:
      event !== 'pull_request' || files.some((file) => FAULT_PATHS.test(file)),
    check: { part: check },
    unit: {
      include: Object.entries(unitGroups).flatMap(([group, names]) => {
        const selected = names.filter((name) => reaches([name]));
        return selected.length
          ? [
              {
                group,
                filter: selected
                  .map((name) => `--filter @pertexo/${name}`)
                  .join(' '),
              },
            ]
          : [];
      }),
    },
    integration: {
      include: Object.entries(integrationGroups).flatMap(([group, names]) =>
        reaches(names) ? [{ group }] : [],
      ),
    },
    browser: {
      include: browserMatrix(selectedBrowser).filter(({ suite }) =>
        reaches(suite.startsWith('mocked') ? ['web'] : liveWorkspaces),
      ),
    },
  };
}

const MOCKED_SPECS_PER_JOB = 20;
const LIVE_JOURNEYS_PER_JOB = 8;

function liveBrowserEntries(journeys, count) {
  return assignDurationShards(journeys, liveDurations, count)
    .sort(
      (a, b) =>
        Number(b.files.includes('code')) - Number(a.files.includes('code')),
    )
    .map(({ files }, index) => ({
      suite: `live-${index + 1}`,
      journeys: files.join(' '),
    }));
}

function browserMatrix(selected) {
  if (selected === undefined) return browserEntries;
  const mocked = selected.filter((name) => name.startsWith('e2e/'));
  const live = selected
    .filter((name) => name.startsWith('journey:'))
    .map((name) => name.slice(8));
  const mockedCount = Math.min(
    fullMockedShards.length,
    Math.ceil(mocked.length / MOCKED_SPECS_PER_JOB),
  );
  const liveCount = Math.min(
    browserEntries.filter(({ suite }) => suite.startsWith('live')).length,
    Math.ceil(live.length / LIVE_JOURNEYS_PER_JOB),
  );
  return [
    ...assignDurationShards(mocked, mockedDurations, mockedCount).map(
      ({ files }, index) => ({
        suite: `mocked-${index + 1}`,
        journeys: '',
        shard: `${index + 1}/${mockedCount}`,
        specs: JSON.stringify(files),
      }),
    ),
    ...liveBrowserEntries(live, liveCount),
  ];
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [filesPath, event = 'pull_request'] = process.argv.slice(2);
  const selection = selectJobs(
    JSON.parse(readFileSync(filesPath, 'utf8')),
    readWorkspaces(),
    event,
  );
  for (const [name, value] of Object.entries(selection)) {
    const line = `${name}=${JSON.stringify(value)}\n`;
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, line);
    else process.stdout.write(line);
  }
}
