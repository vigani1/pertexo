#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

export const SOURCE_COVERAGE_COHORTS = Object.freeze([
  'api',
  'api-orchestration',
  'api-priority',
  'api-run-event-publisher',
  'worker',
  'worker-lifecycle',
  'database',
  'database-integration',
  'artifact-store',
  'contracts',
  'integrations',
  'workflow-engine',
  'workflow-model',
  'node-sdk',
  'node-catalog',
  'nodes-core',
  'observability',
  'queue',
  'rate-limit',
  'lifecycle-command',
]);

const SOURCE_ROOTS = Object.freeze(['apps', 'packages']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isDeclarationOnlyStatement(statement) {
  if (
    ts.isImportDeclaration(statement) ||
    ts.isImportEqualsDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isExportDeclaration(statement) ||
    ts.isEmptyStatement(statement)
  )
    return true;
  return (
    ts.canHaveModifiers(statement) &&
    ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ===
      true
  );
}

export function classifySourceKind(file, source) {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  return parsed.statements.every(isDeclarationOnlyStatement)
    ? 'declarations-imports-or-reexports-only'
    : 'runtime-statements-present';
}

function sourceOwner(file) {
  const [collection, owner] = file.split('/');
  return `${collection}/${owner}`;
}

function isRunnableEntrypoint(file) {
  return /\/(?:main|run|server)\.ts$/u.test(file);
}

function measurementDisposition(kind, coverage, testSuites) {
  if (coverage.length > 0)
    return kind === 'runtime-statements-present'
      ? 'measured-runtime'
      : 'measured-declaration';
  if (kind !== 'runtime-statements-present')
    return 'build-type-export-contract';
  return testSuites.length > 0
    ? 'owner-suite-source-mapped'
    : 'unmapped-runtime-source';
}

function moduleSpecifiers(file, source) {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifiers.push(node.moduleSpecifier.text);
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    )
      specifiers.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

function resolveLocalModule(importer, specifier, availableFiles) {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), specifier),
  );
  return [
    base,
    base.replace(/\.js$/u, '.ts'),
    `${base}.ts`,
    `${base}/index.ts`,
  ].find((candidate) => availableFiles.has(candidate));
}

export function mapSourceTestSuites({ sources, tests }) {
  const availableFiles = new Set([...sources.keys(), ...tests.keys()]);
  const dependencies = new Map(
    [...availableFiles].map((file) => {
      const source = sources.get(file) ?? tests.get(file);
      if (source === undefined)
        throw new Error(`Missing source text for ${file}`);
      return [
        file,
        moduleSpecifiers(file, source)
          .map((specifier) =>
            resolveLocalModule(file, specifier, availableFiles),
          )
          .filter((dependency) => dependency !== undefined),
      ];
    }),
  );
  const suitesBySource = new Map();
  for (const suite of [...tests.keys()]
    .filter((file) => file.endsWith('.test.ts'))
    .sort()) {
    const visited = new Set();
    const pending = [suite];
    while (pending.length > 0) {
      const file = pending.pop();
      if (file === undefined || visited.has(file)) continue;
      visited.add(file);
      if (sources.has(file)) {
        const suites = suitesBySource.get(file) ?? [];
        suites.push(suite);
        suitesBySource.set(file, suites);
      }
      pending.push(...(dependencies.get(file) ?? []));
    }
  }
  return suitesBySource;
}

function normalizedCoverageByFile(coverageReports, rootDirectory) {
  const byFile = new Map();
  for (const [cohort, report] of coverageReports) {
    for (const [absoluteFile, coverage] of Object.entries(report)) {
      const file = path.relative(rootDirectory, absoluteFile);
      const statements = Object.values(coverage.s ?? {});
      const item = {
        cohort,
        statementLocations: statements.length,
        hitStatementLocations: statements.filter((hits) => hits > 0).length,
      };
      const existing = byFile.get(file) ?? [];
      existing.push(item);
      byFile.set(file, existing);
    }
  }
  for (const coverage of byFile.values())
    coverage.sort((left, right) => left.cohort.localeCompare(right.cohort));
  return byFile;
}

function uncoveredByFile(riskReport) {
  const counts = new Map();
  for (const branch of riskReport.uncoveredBranches ?? [])
    counts.set(branch.file, (counts.get(branch.file) ?? 0) + 1);
  return counts;
}

export function createSourceInventory({
  artifactHashes,
  coverageReports,
  generatedAt,
  packageManager,
  riskReport,
  rootDirectory,
  sources,
  testSuitesBySource = new Map(),
}) {
  const coverageByFile = normalizedCoverageByFile(
    coverageReports,
    rootDirectory,
  );
  const riskByFile = uncoveredByFile(riskReport);
  const files = [...sources.entries()]
    .map(([file, source]) => {
      const kind = classifySourceKind(file, source);
      const coverage = coverageByFile.get(file) ?? [];
      const testSuites = testSuitesBySource.get(file) ?? [];
      return {
        file,
        kind,
        sha256: sha256(source),
        owner: sourceOwner(file),
        measurementDisposition: measurementDisposition(
          kind,
          coverage,
          testSuites,
        ),
        coverage,
        ...(coverage.length === 0 && kind === 'runtime-statements-present'
          ? { ownerTestSuites: testSuites }
          : {}),
        registeredUncovered: riskByFile.get(file) ?? 0,
        ...(isRunnableEntrypoint(file) ? { runnableEntrypoint: true } : {}),
      };
    })
    .sort((left, right) => left.file.localeCompare(right.file));
  const sourceFingerprint = sha256(
    files.map((file) => `${file.file}\0${file.sha256}`).join('\n'),
  );
  const counts = files.reduce(
    (summary, file) => {
      summary[file.measurementDisposition] += 1;
      return summary;
    },
    {
      'measured-runtime': 0,
      'measured-declaration': 0,
      'owner-suite-source-mapped': 0,
      'unmapped-runtime-source': 0,
      'build-type-export-contract': 0,
    },
  );
  const unmeasuredRunnableEntrypoints = files
    .filter(
      (file) =>
        file.runnableEntrypoint === true &&
        (file.measurementDisposition === 'owner-suite-source-mapped' ||
          file.measurementDisposition === 'unmapped-runtime-source'),
    )
    .map((file) => file.file);
  return {
    schemaVersion: 3,
    generatedAt,
    sourceFingerprint: `sha256:${sourceFingerprint}`,
    scope:
      'Every apps/*/src and packages/*/src TypeScript file. Coverage presence is selected-cohort evidence, not proof that every path ran. For unselected runtime files, ownerTestSuites records exact test files with a static relative-import path to the source; this proves source ownership, not execution. Empty ownerTestSuites are explicit unmapped evidence gaps. Declaration-only files retain build, type, and export-contract evidence.',
    sourceFiles: files.length,
    dispositionCounts: counts,
    unmeasuredRunnableEntrypoints,
    coverageCohorts: [...coverageReports.keys()],
    provenance: {
      command: 'pnpm coverage:evidence',
      prerequisite: 'pnpm test:coverage',
      node: process.version,
      packageManager,
      typescript: ts.version,
      artifacts: artifactHashes,
      riskSourceRevision: riskReport.sourceRevision,
    },
    files,
  };
}

async function sourceFilesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFilesBelow(item)));
    else if (entry.isFile() && item.endsWith('.ts') && !item.endsWith('.d.ts'))
      files.push(item);
  }
  return files;
}

async function testFilesInCollection(rootDirectory, collection) {
  const collectionDirectory = path.join(rootDirectory, collection);
  const owners = await readdir(collectionDirectory, { withFileTypes: true });
  return (
    await Promise.all(
      owners
        .filter((owner) => owner.isDirectory())
        .map(async (owner) => {
          const testDirectory = path.join(
            collectionDirectory,
            owner.name,
            'test',
          );
          try {
            return await sourceFilesBelow(testDirectory);
          } catch (error) {
            if (error?.code === 'ENOENT') return [];
            throw error;
          }
        }),
    )
  ).flat();
}

export async function sourceFilesInCollection(rootDirectory, collection) {
  const collectionDirectory = path.join(rootDirectory, collection);
  const owners = await readdir(collectionDirectory, { withFileTypes: true });
  return (
    await Promise.all(
      owners
        .filter((owner) => owner.isDirectory())
        .map((owner) =>
          sourceFilesBelow(path.join(collectionDirectory, owner.name, 'src')),
        ),
    )
  ).flat();
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function optionalSha256(file) {
  try {
    return `sha256:${sha256(await readFile(file))}`;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function main() {
  const rootDirectory = process.cwd();
  const sourcePaths = (
    await Promise.all(
      SOURCE_ROOTS.map((root) => sourceFilesInCollection(rootDirectory, root)),
    )
  )
    .flat()
    .sort();
  const sources = new Map(
    await Promise.all(
      sourcePaths.map(async (file) => [
        path.relative(rootDirectory, file),
        await readFile(file, 'utf8'),
      ]),
    ),
  );
  const testPaths = (
    await Promise.all(
      SOURCE_ROOTS.map((root) => testFilesInCollection(rootDirectory, root)),
    )
  )
    .flat()
    .sort();
  const tests = new Map(
    await Promise.all(
      testPaths.map(async (file) => [
        path.relative(rootDirectory, file),
        await readFile(file, 'utf8'),
      ]),
    ),
  );
  const coverageReports = new Map(
    await Promise.all(
      SOURCE_COVERAGE_COHORTS.map(async (cohort) => [
        cohort,
        await readJson(
          path.join(rootDirectory, 'coverage', cohort, 'coverage-final.json'),
        ),
      ]),
    ),
  );
  const riskFile = path.join(
    rootDirectory,
    'coverage/risk-uncovered-branches.json',
  );
  const reviewFile = path.join(
    rootDirectory,
    'infrastructure/risk-coverage-reviews.json',
  );
  const riskReport = await readJson(riskFile);
  const coverageArtifacts = await Promise.all(
    SOURCE_COVERAGE_COHORTS.map(async (cohort) => {
      const coverageFile = `coverage/${cohort}/coverage-final.json`;
      const resultFile = `coverage/${cohort}/test-results.json`;
      return {
        cohort,
        coverageFile,
        coverageSha256: await optionalSha256(coverageFile),
        resultFile,
        resultSha256: await optionalSha256(resultFile),
      };
    }),
  );
  const packageJson = await readJson(path.join(rootDirectory, 'package.json'));
  const inventory = createSourceInventory({
    artifactHashes: {
      coverage: coverageArtifacts,
      reviewManifest: await optionalSha256(reviewFile),
      riskReport: await optionalSha256(riskFile),
    },
    coverageReports,
    generatedAt: riskReport.generatedAt,
    packageManager: packageJson.packageManager,
    riskReport,
    rootDirectory,
    sources,
    testSuitesBySource: mapSourceTestSuites({ sources, tests }),
  });
  await writeFile(
    path.join(rootDirectory, 'docs/remaining-work/source-inventory.json'),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  await writeFile(
    path.join(rootDirectory, 'docs/remaining-work/risk-snapshot.json'),
    `${JSON.stringify(riskReport, null, 2)}\n`,
  );
  process.stdout.write(
    `Recorded ${String(inventory.sourceFiles)} source files, ${String(inventory.dispositionCounts['owner-suite-source-mapped'])} source-mapped owner-suite files, ${String(inventory.dispositionCounts['unmapped-runtime-source'])} unmapped runtime files, and ${String(inventory.unmeasuredRunnableEntrypoints.length)} unselected runnable entrypoints.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  await main();
