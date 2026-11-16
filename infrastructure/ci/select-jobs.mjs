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
export const browserEntries = [
  { suite: 'mocked-1', journeys: '', shard: '1/2' },
  { suite: 'mocked-2', journeys: '', shard: '2/2' },
  {
    suite: 'live-1',
    journeys:
      'pinned-samples curated-templates schedule code approvals failure-routing promotion run-recovery task-timeouts portability organization-saml http-pagination run-values api-tokens two-factor',
  },
  {
    suite: 'live-2',
    journeys:
      'collaboration workflow-organization variables transforms oauth2 forms expression-admission spreadsheets readonly duplication federation receipts input-cases connection-health first-use',
  },
  {
    suite: 'live-3',
    journeys:
      'artifact-inputs product webhook-responses webhook-controlled-http nested-conflict callable security governance error-workflows form-uploads notifications organization-oidc email-attachments workflow-concurrency usage',
  },
];
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
  const check = ['static'];
  if (all) check.push('deploy');
  if (reaches(['web'])) check.push('lint-web');
  if (all || [...affected].some((name) => name !== '@pertexo/web'))
    check.push('lint-rest');
  return {
    code,
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
      include: browserEntries.filter(({ suite }) =>
        reaches(suite.startsWith('mocked') ? ['web'] : liveWorkspaces),
      ),
    },
  };
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
