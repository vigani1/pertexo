import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'prettier';

const root = resolve(new URL('../..', import.meta.url).pathname);
const web = `${root}/apps/web`;
function files(directory, suffix) {
  return readdirSync(directory, { recursive: true })
    .filter((file) => file.endsWith(suffix))
    .map((file) => `${directory}/${file}`);
}
function imports(file) {
  const text = readFileSync(file, 'utf8');
  return [
    ...text.matchAll(/(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/gu),
  ].flatMap(([, name]) => {
    const path = name.startsWith('@/')
      ? `${web}/src/${name.slice(2)}`
      : name.startsWith('.')
        ? resolve(dirname(file), name)
        : '';
    if (!path) return [];
    return [
      path,
      `${path}.ts`,
      `${path}.tsx`,
      `${path}/index.ts`,
      `${path}/index.tsx`,
      path.replace(/\.js$/u, '.ts'),
    ]
      .filter((candidate) => existsSync(candidate) && extname(candidate))
      .slice(0, 1);
  });
}
function deriveBrowserReach() {
  const routeOwners = [];
  const featureNames = readdirSync(`${web}/src/features`);
  for (const file of [
    ...files(`${web}/src/routes`, '.ts'),
    ...files(`${web}/src/routes`, '.tsx'),
  ]) {
    const text = readFileSync(file, 'utf8');
    for (const block of text.split('createRoute({').slice(1)) {
      const path = /path: ['"]([^'"]+)/u.exec(block)?.[1];
      const module = /import\(['"](\.[^'"]+)/u.exec(block)?.[1];
      if (path && module) {
        const target = resolve(dirname(file), module);
        const source = [`${target}.tsx`, `${target}.ts`].find(existsSync);
        if (source) {
          const parent =
            path === '/'
              ? /path: ['"]([^'"]*\$[^'"]+)/u.exec(text)?.[1]
              : undefined;
          routeOwners.push([
            `/${(parent ?? path).replace(/^\//u, '')}`,
            source,
          ]);
        }
      }
    }
  }
  function reach(seeds) {
    const seen = new Set();
    const features = new Set(['auth', 'workspaces']);
    let broad = seeds.some((file) => file.includes('/appearance/'));
    let owned = false;
    function visit(file) {
      if (seen.has(file)) return;
      seen.add(file);
      const owner = /\/src\/features\/([^/]+)\//u.exec(file)?.[1];
      if (owner) features.add(owner);
      const text = readFileSync(file, 'utf8');
      if (!file.includes('/src/')) {
        const relative = file.slice(web.length + 1);
        for (const feature of featureNames) {
          if (
            relative
              .split('/')
              .some((part) => part === feature || part === `${feature}.spec.ts`)
          ) {
            owned = true;
            for (const source of [
              ...files(`${web}/src/features/${feature}`, '.ts'),
              ...files(`${web}/src/features/${feature}`, '.tsx'),
            ])
              visit(source);
          }
        }
        if (/createEditorWorkspace|openNewEditorWorkspace/u.test(text))
          features.add('overview');
        for (const [route, source] of routeOwners) {
          const prefix = route.replace(/\$\w+.*/u, '');
          if (prefix !== '/' && text.includes(prefix)) {
            owned = true;
            visit(source);
          }
        }
        if (/['"`]\/w\/\$\{[^}]+\}['"`]/u.test(text)) features.add('overview');
      }
      for (const dependency of imports(file)) {
        if (!dependency.includes('/src/routes/') || !file.includes('/src/'))
          visit(dependency);
      }
    }
    for (const file of seeds) visit(file);
    // Specs without a statically identified page and appearance checks cover every feature.
    broad ||= !owned;
    return broad ? 'all' : [...features].sort();
  }
  const result = {};
  for (const file of files(`${web}/e2e`, '.spec.ts'))
    result[file.slice(web.length + 1)] = reach([file]);
  const catalog = readFileSync(
    `${root}/apps/api/test/browser/editor/fixture/environment.ts`,
    'utf8',
  )
    .split('const EDITOR_JOURNEY_PATHS = {')[1]
    .split('} satisfies')[0];
  const paths = Object.fromEntries(
    [...catalog.matchAll(/^ {2}(?:'([^']+)'|([\w-]+)): '([^']+)',$/gmu)].map(
      ([, quoted, plain, path]) => [quoted || plain, path],
    ),
  );
  Object.assign(paths, {
    'artifact-inputs': 'editor/files',
    usage: 'usage-capacity.spec.ts',
    security: 'security',
    'organization-saml': 'editor/federation/saml.spec.ts',
    'workflow-concurrency': 'workflow-concurrency.spec.ts',
    'connection-health': 'connection-health.spec.ts',
    oauth2: 'oauth2-connections.spec.ts',
    'workflow-organization': 'workflow-organization.spec.ts',
  });
  for (const [name, path] of Object.entries(paths)) {
    const target = `${web}/e2e-live/${path}`;
    result[`journey:${name}`] = reach(
      path.endsWith('.ts') ? [target] : files(target, '.spec.ts'),
    );
  }
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
  );
}
export function reachFreshnessErrors(actual, expected = deriveBrowserReach()) {
  return [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
    .filter(
      (key) => JSON.stringify(actual[key]) !== JSON.stringify(expected[key]),
    )
    .map(
      (key) =>
        `Reach changed: ${key}; run node infrastructure/testing/derive-browser-reach.mjs`,
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  writeFileSync(
    `${root}/infrastructure/testing/browser-reach.json`,
    await format(JSON.stringify(deriveBrowserReach()), { parser: 'json' }),
  );
