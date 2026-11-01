#!/usr/bin/env node
// One-shot move of every area from packages/database into packages/core (ADR 091).
// Mechanical: it moves files and rewrites module specifiers with the TypeScript
// parser; it never edits a line of logic. It's driven by folders, so a new file in a
// moved folder moves too, and it prints what it can't place instead of guessing.
//
//   node scripts/refactor/move-areas-to-core.mjs            run on a clean checkout, stages all
//   node scripts/refactor/move-areas-to-core.mjs --plan     print the plan, change nothing
//   node scripts/refactor/move-areas-to-core.mjs --prove <base>   compare HEAD with <base>
//
// Needs `pnpm install` first. Exit 0: done, or already moved. Exit 2: done, but read
// the "couldn't handle" list.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const ts = createRequire(path.join(ROOT, 'package.json'))('typescript');
const posix = path.posix;

const DB = 'packages/database';
const CORE = 'packages/core';
const EXECUTION = 'packages/execution';

// ---------------------------------------------------------------------------
// The mapping: this is all the script knows about the tree.
// ---------------------------------------------------------------------------

/** Every folder of database/src that moves to core/src under the same name. */
const AREAS = [
  'artifacts',
  'attempts',
  'authoring',
  'connections',
  'data-tables',
  'governance',
  'identity',
  'inbox',
  'lifecycle',
  'notifications',
  'operator',
  'outbox',
  'previews',
  'runs',
  'tenant-access',
  'triggers',
  'variables',
];

/** What stays in database/src for good, or until `platform`'s own step (ADR 091). */
const STAYS = {
  files: [
    'config.ts',
    'database.ts',
    'migrate.ts',
    'migrations.ts',
    'primitives.ts',
    'schema.ts',
    'testing.ts',
    // Transaction helpers.
    'tenant-access/transactions.ts',
    // The shared outbox and audit helpers; projection.ts supplies the audit key type.
    'outbox/events.repository.ts',
    'governance/audit/events.repository.ts',
    'governance/audit/projection.ts',
  ],
  folders: ['schema/', 'platform/', 'tenant-access/transactions/'],
};

/** Files that don't keep their folder: authority and folder scope go to shared/. */
const RELOCATED = new Map([
  [
    `${DB}/src/tenant-access/workspaces/authority.queries.ts`,
    `${CORE}/src/shared/authority.queries.ts`,
  ],
  [
    `${DB}/src/tenant-access/resources/facts.queries.ts`,
    `${CORE}/src/shared/facts.queries.ts`,
  ],
  [
    `${DB}/src/tenant-access/resources/scope.queries.ts`,
    `${CORE}/src/shared/scope.queries.ts`,
  ],
  // The one runtime cut: `platform` and database.ts need these limits, and they
  // import nothing, so they go down rather than the door going up.
  [
    `${DB}/src/runs/capacity/instance-limits.ts`,
    `${DB}/src/platform/instance-limits.ts`,
  ],
]);

/** Test folders that stay unless a test in them reaches code in core. */
const TEST_FOLDERS_THAT_STAY = ['platform/'];

/** Database doors that disappear, and where their importers go. */
const MOVED_DOORS = new Map(
  AREAS.filter((area) => area !== 'variables').map((area) => [
    `@pertexo/database/${area}`,
    area,
  ]),
);
MOVED_DOORS.set('@pertexo/execution', 'execution');

const SHAPES_FILE = `${DB}/src/schema/stored-shapes.ts`;

/**
 * The column types the schema stamps with `$type`, down in `schema/` so it needn't
 * import an area. Each keeps the name the schema already used, so a schema file's
 * only change is its import line. An area's contract keeps its fuller type until the
 * area's pass; core/test/shared/stored-shapes.test.ts fails to compile if they differ.
 */
const STORED_SHAPES = `// The column types the schema stamps with \`$type\`, so tables need no area's code.
// An area's contract still has its own fuller type until that area's pass; the
// compile-time test in core/test/shared/stored-shapes.test.ts holds them equal.
import type {
  ConnectionAuthType,
  ConnectionStatus,
  FailureNotificationDestinationConfig,
} from '@pertexo/workflow-model';

type SideEffectClass = 'safe' | 'idempotent_with_key' | 'unsafe';

export type { ConnectionAuthType, ConnectionStatus };
export type FolderAccess = 'viewer' | 'editor';
export type FolderFact = Readonly<{ accessMode: 'workspace' | 'restricted' }>;
export type WorkflowTriggerHealth = Readonly<{
  kind: 'webhook' | 'schedule';
  healthStatus: 'pending' | 'healthy' | 'degraded' | 'unhealthy' | 'disabled';
}>;
type DirectoryEmail = Readonly<{
  value: string;
  type?: string;
  primary: boolean;
}>;
export type DirectoryUserProfile = Readonly<{
  displayName?: string;
  name?: Readonly<{
    formatted?: string;
    familyName?: string;
    givenName?: string;
    middleName?: string;
    honorificPrefix?: string;
    honorificSuffix?: string;
  }>;
  /** The canonical primary address is first; only verified SSO may bind it. */
  emails: readonly [DirectoryEmail, ...DirectoryEmail[]];
}>;
export type DestinationConfig = FailureNotificationDestinationConfig;
export type StoredDestinationConfig =
  | Omit<Extract<DestinationConfig, { kind: 'email' }>, 'kind'>
  | Omit<Extract<DestinationConfig, { kind: 'slack' }>, 'kind'>;
export type FailureNotificationClaimResult = Readonly<{
  kind: 'ready';
  sideEffectClass: SideEffectClass;
}>;
export type NodeAttemptLease = Readonly<{
  sideEffectClass: SideEffectClass;
  admissionKind: 'execute' | 'retry' | 'wait_resume';
}>;
export type PreviewAttemptLease = Readonly<{
  sideEffectClass: SideEffectClass;
  dryRun: 'not_supported' | 'provider_supported';
}>;
export type PreviewStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'timed_out'
  | 'outcome_unknown';
export type AcceptanceInput = Readonly<{
  triggerType:
    | 'test'
    | 'api'
    | 'manual'
    | 'replay'
    | 'schedule'
    | 'webhook'
    | 'workflow_call'
    | 'workflow_error'
    | 'form';
}>;
export type GenericOperatorCommandResult = Readonly<{
  result: Readonly<Record<string, unknown>>;
  status: 'completed' | 'failed' | 'pending';
}>;
export type OperatorCommandRecord = Readonly<{
  commandType:
    | 'attempt.reconcile'
    | 'due-work.resume'
    | 'outbox.redispatch'
    | 'run.cancel'
    | 'run.replay'
    | 'trigger.reconcile'
    | 'unknown-outcome.record-evidence';
}>;
export type ArtifactStatus = 'available' | 'deleted' | 'deleting' | 'pending';
export type WebhookDeliveryOutcome =
  | 'accepted'
  | 'coordinated'
  | 'skipped'
  | 'replayed'
  | 'authentication_failed'
  | 'invalid_request'
  | 'conflict'
  | 'rate_limited'
  | 'paused';
export type WebhookSignatureCheck = 'verified' | 'mismatch' | 'not_checked';
export type WebhookReplayCheck =
  | 'new'
  | 'duplicate'
  | 'conflict'
  | 'stale_timestamp'
  | 'not_checked';
export type RecordedScheduleOccurrence = 'accepted' | 'skipped' | 'paused';
export type ScheduleTriggerRecord = Readonly<{
  misfirePolicy: 'skip' | 'catch_up_once';
  healthStatus: 'healthy' | 'degraded' | 'unhealthy' | 'disabled';
}>;
`;

/** The names schema files may import from `SHAPES_FILE`; anything else is reported. */
const STORED_SHAPE_NAMES = new Set(
  [...STORED_SHAPES.matchAll(/^export type (\w+)/gmu)]
    .map((match) => match[1])
    .concat(['ConnectionAuthType', 'ConnectionStatus']),
);

/** Compile-time pin that the two copies of each stored shape stay equal. */
const STORED_SHAPES_TEST = `import type {
  AcceptanceInput as StoredAcceptanceInput,
  ArtifactStatus as StoredArtifactStatus,
  ConnectionAuthType as StoredConnectionAuthType,
  ConnectionStatus as StoredConnectionStatus,
  DestinationConfig as StoredDestinationConfigKind,
  DirectoryUserProfile as StoredDirectoryUserProfile,
  FailureNotificationClaimResult as StoredClaimResult,
  FolderAccess as StoredFolderAccess,
  FolderFact as StoredFolderFact,
  GenericOperatorCommandResult as StoredOperatorResult,
  NodeAttemptLease as StoredNodeAttemptLease,
  OperatorCommandRecord as StoredOperatorRecord,
  PreviewAttemptLease as StoredPreviewAttemptLease,
  PreviewStatus as StoredPreviewStatus,
  RecordedScheduleOccurrence as StoredOccurrence,
  ScheduleTriggerRecord as StoredScheduleTrigger,
  StoredDestinationConfig,
  WebhookDeliveryOutcome as StoredDeliveryOutcome,
  WebhookReplayCheck as StoredReplayCheck,
  WebhookSignatureCheck as StoredSignatureCheck,
  WorkflowTriggerHealth as StoredTriggerHealth,
} from '@pertexo/database/schema';
import { expectTypeOf, it } from 'vitest';

import type { NodeAttemptLease } from '../../src/attempts/contract.js';
import type { ArtifactStatus } from '../../src/artifacts/contract.js';
import type {
  ConnectionAuthType,
  ConnectionStatus,
} from '../../src/connections/contract.js';
import type { DirectoryUserProfile } from '../../src/identity/federation/provisioning/contract.js';
import type { FailureNotificationClaimResult } from '../../src/notifications/contract.js';
import type {
  DestinationConfig,
  StoredDestinationConfig as AreaStoredDestinationConfig,
} from '../../src/notifications/destinations/contract.js';
import type {
  GenericOperatorCommandResult,
  OperatorCommandRecord,
} from '../../src/operator/contract.js';
import type {
  PreviewAttemptLease,
  PreviewStatus,
} from '../../src/previews/contract.js';
import type { AcceptanceInput } from '../../src/runs/commands/acceptance/input.js';
import type {
  FolderAccess,
  FolderFact,
} from '../../src/tenant-access/resources/contract.js';
import type { WorkflowTriggerHealth } from '../../src/triggers/reconciliation/contract.js';
import type { RecordedScheduleOccurrence } from '../../src/triggers/schedules/contract.js';
import type { ScheduleTriggerRecord } from '../../src/triggers/schedules/management/contract.js';
import type {
  WebhookDeliveryOutcome,
  WebhookReplayCheck,
  WebhookSignatureCheck,
} from '../../src/triggers/webhooks/contract.js';

// \`pnpm typecheck\` is the real assertion: a schema column and an area's contract
// can't drift apart without this file failing to compile.
it('keeps the types stamped on columns equal to the area contracts', () => {
  expectTypeOf<StoredFolderAccess>().toEqualTypeOf<FolderAccess>();
  expectTypeOf<StoredFolderFact['accessMode']>().toEqualTypeOf<
    FolderFact['accessMode']
  >();
  expectTypeOf<StoredTriggerHealth['kind']>().toEqualTypeOf<
    WorkflowTriggerHealth['kind']
  >();
  expectTypeOf<StoredTriggerHealth['healthStatus']>().toEqualTypeOf<
    WorkflowTriggerHealth['healthStatus']
  >();
  expectTypeOf<StoredConnectionAuthType>().toEqualTypeOf<ConnectionAuthType>();
  expectTypeOf<StoredConnectionStatus>().toEqualTypeOf<ConnectionStatus>();
  expectTypeOf<StoredDirectoryUserProfile>().toEqualTypeOf<DirectoryUserProfile>();
  expectTypeOf<StoredDestinationConfigKind>().toEqualTypeOf<DestinationConfig>();
  expectTypeOf<StoredDestinationConfig>().toEqualTypeOf<AreaStoredDestinationConfig>();
  expectTypeOf<StoredClaimResult['sideEffectClass']>().toEqualTypeOf<
    Extract<FailureNotificationClaimResult, { kind: 'ready' }>['sideEffectClass']
  >();
  expectTypeOf<StoredNodeAttemptLease['sideEffectClass']>().toEqualTypeOf<
    NodeAttemptLease['sideEffectClass']
  >();
  expectTypeOf<StoredNodeAttemptLease['admissionKind']>().toEqualTypeOf<
    NodeAttemptLease['admissionKind']
  >();
  expectTypeOf<StoredPreviewAttemptLease['sideEffectClass']>().toEqualTypeOf<
    PreviewAttemptLease['sideEffectClass']
  >();
  expectTypeOf<StoredPreviewAttemptLease['dryRun']>().toEqualTypeOf<
    PreviewAttemptLease['dryRun']
  >();
  expectTypeOf<StoredPreviewStatus>().toEqualTypeOf<PreviewStatus>();
  expectTypeOf<StoredAcceptanceInput['triggerType']>().toEqualTypeOf<
    AcceptanceInput['triggerType']
  >();
  expectTypeOf<StoredOperatorResult['result']>().toEqualTypeOf<
    GenericOperatorCommandResult['result']
  >();
  expectTypeOf<StoredOperatorResult['status']>().toEqualTypeOf<
    GenericOperatorCommandResult['status']
  >();
  expectTypeOf<StoredOperatorRecord['commandType']>().toEqualTypeOf<
    OperatorCommandRecord['commandType']
  >();
  expectTypeOf<StoredArtifactStatus>().toEqualTypeOf<ArtifactStatus>();
  expectTypeOf<StoredDeliveryOutcome>().toEqualTypeOf<WebhookDeliveryOutcome>();
  expectTypeOf<StoredSignatureCheck>().toEqualTypeOf<WebhookSignatureCheck>();
  expectTypeOf<StoredReplayCheck>().toEqualTypeOf<WebhookReplayCheck>();
  expectTypeOf<StoredOccurrence>().toEqualTypeOf<RecordedScheduleOccurrence>();
  expectTypeOf<StoredScheduleTrigger['misfirePolicy']>().toEqualTypeOf<
    ScheduleTriggerRecord['misfirePolicy']
  >();
  expectTypeOf<StoredScheduleTrigger['healthStatus']>().toEqualTypeOf<
    ScheduleTriggerRecord['healthStatus']
  >();
});
`;

/**
 * Exact-text edits to files that name paths. A text that isn't there is reported,
 * because a newer tree may have reworded it and only a person can tell what's right.
 */
const TEXT_EDITS = [
  {
    file: `${CORE}/src/runs/commands/initial-checkpoint.ts`,
    from: '`@pertexo/execution` provides it.',
    to: '`@pertexo/core/execution` provides it.',
  },
  {
    file: 'eslint.config.mjs',
    from: `    files: readableWorkspaces.map(
      (workspace) => \`\${workspace}/test/**/*.{ts,tsx}\`,
    ),
    rules: { 'max-lines-per-function': 'off' },
`,
    to: `    files: [
      ...readableWorkspaces.map(
        (workspace) => \`\${workspace}/test/**/*.{ts,tsx}\`,
      ),
      // Test helpers behind @pertexo/database/testing, used by two packages' tests.
      'packages/database/src/testing/**/*.ts',
    ],
    rules: { 'max-lines-per-function': 'off' },
`,
  },
  {
    file: 'eslint.config.mjs',
    from: `    // as does the workflow-model entry point, which only lists its exports.
    files: [
      'packages/workflow-model/src/index.ts',
`,
    to: `    // as do the entry points that only list their exports.
    files: [
      'packages/database/src/schema.ts',
      'packages/workflow-model/src/index.ts',
`,
  },
  {
    file: 'eslint.config.mjs',
    from: `      'packages/database/src/schema.ts',
      'packages/workflow-model/src/index.ts',
`,
    to: `      'packages/database/src/schema.ts',
      'packages/workflow-model/src/index.ts',
      // At the limit already; the move split its test-door import in two.
      'apps/worker/test/support/workflow-lifecycle.integration.support.ts',
`,
  },
  {
    file: '.github/workflows/ci.yml',
    from: `              --filter @pertexo/contracts --filter @pertexo/core --filter
              @pertexo/execution --filter @pertexo/integrations --filter`,
    to: `              --filter @pertexo/contracts --filter @pertexo/core --filter
              @pertexo/integrations --filter`,
  },
  {
    file: '.github/workflows/ci.yml',
    from: `          pnpm --filter @pertexo/database exec vitest run --config vitest.integration.config.ts \\
            --exclude 'test/authoring/organization/**'
          EDITOR_BROWSER_OWNED_FIXTURE=true F07_ORGANIZATION_OWNED_FIXTURE=true \\
            pnpm --filter @pertexo/database exec vitest run --config vitest.integration.config.ts \\
            test/authoring/organization/
          pnpm --filter @pertexo/core exec vitest run --config vitest.integration.config.ts
`,
    to: `          pnpm --filter @pertexo/database exec vitest run --config vitest.integration.config.ts
          pnpm --filter @pertexo/core exec vitest run --config vitest.integration.config.ts \\
            --exclude 'test/authoring/organization/**'
          EDITOR_BROWSER_OWNED_FIXTURE=true F07_ORGANIZATION_OWNED_FIXTURE=true \\
            pnpm --filter @pertexo/core exec vitest run --config vitest.integration.config.ts \\
            test/authoring/organization/
`,
  },
  {
    file: 'Dockerfile',
    from: 'COPY --from=build --chown=10001:10001 /workspace/packages/execution/dist ./packages/execution/dist\n',
    to: '',
  },
  {
    file: 'eslint.config.mjs',
    from: `  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@pertexo/database',
              message:
                'Import a database entry point, such as @pertexo/database/primitives.',
            },
          ],`,
    to: `  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@pertexo/nodes-core',
              allowImportNames: ['CORE_SCHEDULE_CONFIG_SCHEMA'],
              allowTypeImports: true,
              message:
                'Core may read the shared schedule configuration; node execution and request projection belong to callers.',
            },
            {
              name: '@pertexo/database',
              message:
                'Import a database entry point, such as @pertexo/database/primitives.',
            },
          ],`,
  },
];

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

const unhandled = [];
const report = (file, reason) => unhandled.push(`${file}: ${reason}`);

const mode = process.argv[2];

function run() {
  if (!fs.existsSync(`${CORE}/src/shared/workspace-access.ts`))
    throw new Error(
      'packages/core with its shared helper must exist first: land `variables`.',
    );
  if (!fs.existsSync(`${DB}/src/runs`) && !fs.existsSync(EXECUTION)) {
    console.log('Already moved; nothing to do.');
    return;
  }
  if (mode !== '--plan' && git('status', '--porcelain').trim() !== '')
    throw new Error('Run on a clean checkout: the proof compares whole trees.');

  const tracked = git('ls-files').split('\n').filter(Boolean);
  const trackedSet = new Set(tracked);
  const tree = createTree(tracked, trackedSet);
  const moves = planMoves(tree);
  tree.moves = moves;
  const edits = rewriteEverything(tree);

  printPlan(tree, edits);
  if (mode === '--plan') return finish();

  applyMoves(moves);
  writeRewrites(edits, moves);
  writeGeneratedFiles(tree, edits);
  removeExecutionPackage();
  updatePackageConfigs(tree);
  applyTextEdits();
  format();
  git('add', '--all');
  reportStalePaths();
  finish();
}

/** A path in a string, a comment or a config that no parser here can follow. */
function reportStalePaths() {
  const areas = AREAS.join('|');
  const stale = new RegExp(
    `@pertexo/execution|packages/execution|@pertexo/database/(?:${areas})\\b|database/(?:src|test|dist)/(?:${areas})/`,
    'u',
  );
  // History and the checks' own examples may name what used to be.
  const exempt =
    /^(?:docs\/adr\/|docs\/feature-plans\/|docs\/architecture-reset-plan\.md|CHANGELOG\.md|pnpm-lock\.yaml|infrastructure\/checks\/|scripts\/refactor\/)/u;
  const stays = STAYS.files
    .concat(STAYS.folders)
    .map((entry) => `database/src/${entry}`);
  for (const file of git('ls-files').split('\n').filter(Boolean)) {
    if (
      exempt.test(file) ||
      !/\.(?:ts|tsx|mts|mjs|json|ya?ml|md)$|Dockerfile|CODEOWNERS$/u.test(file)
    )
      continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries())
      if (stale.test(line) && !stays.some((entry) => line.includes(entry)))
        report(
          `${file}:${index + 1}`,
          `still names a moved path: ${line.trim().slice(0, 90)}`,
        );
  }
}

function finish() {
  if (unhandled.length === 0) {
    console.log('\nNothing left unhandled.');
    return;
  }
  console.log(
    `\nCouldn't handle ${unhandled.length}, fix these by hand or in the script:`,
  );
  for (const line of [...new Set(unhandled)].sort()) console.log(`  ${line}`);
  process.exitCode = 2;
}

// ---------------------------------------------------------------------------
// The tree: files, parsing, and what each module exports
// ---------------------------------------------------------------------------

function createTree(tracked, trackedSet) {
  const texts = new Map();
  const parsed = new Map();
  const exportMaps = new Map();
  const tree = {
    tracked,
    has: (file) => trackedSet.has(file),
    moves: new Map(),
    loc: (file) => tree.moves.get(file) ?? file,
    text(file) {
      if (!texts.has(file)) texts.set(file, fs.readFileSync(file, 'utf8'));
      return texts.get(file);
    },
    parse(file) {
      if (!parsed.has(file))
        parsed.set(
          file,
          ts.createSourceFile(
            file,
            tree.text(file),
            ts.ScriptTarget.Latest,
            true,
            scriptKind(file),
          ),
        );
      return parsed.get(file);
    },
    resolve(file, specifier) {
      return resolveRelative(tree, file, specifier);
    },
    exportsOf(file) {
      if (!exportMaps.has(file)) {
        exportMaps.set(file, new Map());
        exportMaps.set(file, buildExportMap(tree, file));
      }
      return exportMaps.get(file);
    },
  };
  return tree;
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.(?:m|c)?js$/u.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const isCode = (file) =>
  /\.(?:ts|tsx|mts|cts|mjs|cjs)$/u.test(file) && !/\.d\.[mc]?ts$/u.test(file);

/** A relative specifier to the tracked file it means, seeing through `dist`. */
function resolveRelative(tree, file, specifier) {
  const unresolved = posix.normalize(
    posix.join(posix.dirname(file), specifier),
  );
  const fromDist = unresolved.match(
    /^(packages\/(?:database|execution))\/dist\/(.+)\.m?js$/u,
  );
  if (fromDist) {
    const source = `${fromDist[1]}/src/${fromDist[2]}.ts`;
    return tree.has(source) ? { file: source, dist: true } : undefined;
  }
  const bare = unresolved.replace(/\.(?:js|mjs|ts|tsx|mts)$/u, '');
  for (const candidate of [
    unresolved,
    `${bare}.ts`,
    `${bare}.tsx`,
    `${bare}.mts`,
    `${bare}.mjs`,
    `${unresolved}/index.ts`,
    `${unresolved}/index.tsx`,
  ])
    if (tree.has(candidate)) return { file: candidate, dist: false };
  return undefined;
}

/** name -> { file, name, type }: where each export of a module is really declared. */
function buildExportMap(tree, file) {
  const map = new Map();
  const source = tree.parse(file);
  const imported = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements)
      imported.set(element.name.text, {
        specifier: statement.moduleSpecifier.text,
        name: (element.propertyName ?? element.name).text,
        type: statement.importClause.isTypeOnly || element.isTypeOnly,
      });
  }
  const originOf = (specifier, name, type) => {
    if (!specifier.startsWith('.'))
      return { file: `external:${specifier}`, name, type };
    const target = tree.resolve(file, specifier);
    if (!target) return { file, name, type };
    const origin = tree.exportsOf(target.file).get(name);
    return origin
      ? { ...origin, type: origin.type || type }
      : { file: target.file, name, type };
  };
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier?.text;
      if (!statement.exportClause) {
        const target = tree.resolve(file, specifier);
        if (target)
          for (const [name, origin] of tree.exportsOf(target.file))
            if (name !== 'default') map.set(name, origin);
        continue;
      }
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        const name = (element.propertyName ?? element.name).text;
        const type = statement.isTypeOnly || element.isTypeOnly;
        if (specifier !== undefined)
          map.set(element.name.text, originOf(specifier, name, type));
        else if (imported.has(name)) {
          const from = imported.get(name);
          map.set(
            element.name.text,
            originOf(from.specifier, from.name, from.type || type),
          );
        } else
          map.set(element.name.text, localOrigin(source, file, name, type));
      }
      continue;
    }
    if (
      !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        for (const name of bindingNames(declaration.name))
          map.set(name, { file, name, type: false });
    } else if (statement.name)
      map.set(statement.name.text, {
        file,
        name: statement.name.text,
        type:
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement),
      });
  }
  return map;
}

function localOrigin(source, file, name, type) {
  const declaration = source.statements.find(
    (statement) => statement.name?.text === name,
  );
  const declaredType =
    declaration !== undefined &&
    (ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration));
  return { file, name, type: type || declaredType };
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

// ---------------------------------------------------------------------------
// Where each file goes
// ---------------------------------------------------------------------------

function planMoves(tree) {
  const moves = new Map(RELOCATED);
  const sourcePrefix = `${DB}/src/`;
  for (const file of tree.tracked) {
    if (!file.startsWith(sourcePrefix) || moves.has(file)) continue;
    const relative = file.slice(sourcePrefix.length);
    if (staysInDatabase(relative)) continue;
    const [area] = relative.split('/');
    if (AREAS.includes(area)) moves.set(file, `${CORE}/src/${relative}`);
    else report(file, 'not in the folder mapping: neither moved nor staying');
  }
  for (const file of tree.tracked) {
    if (file.startsWith(`${EXECUTION}/src/`))
      moves.set(
        file,
        `${CORE}/src/execution/${file.slice(`${EXECUTION}/src/`.length)}`,
      );
    else if (file.startsWith(`${EXECUTION}/test/`))
      moves.set(
        file,
        `${CORE}/test/execution/${file.slice(`${EXECUTION}/test/`.length)}`,
      );
  }
  tree.movedSource = new Set(
    [...moves]
      .filter(([, to]) => to.startsWith(`${CORE}/`))
      .map(([from]) => from),
  );
  tree.testingRoutes = readTestingRoutes(tree);
  planTestMoves(tree, moves);
  for (const [from, to] of moves)
    if (tree.has(to)) report(from, `its destination ${to} already exists`);
  return moves;
}

function staysInDatabase(relative) {
  return (
    STAYS.files.includes(relative) ||
    STAYS.folders.some((folder) => relative.startsWith(folder))
  );
}

const isTestFile = (file) => /\.(?:test|spec)\.tsx?$/u.test(file);

/**
 * A test stays only if nothing it reaches ends up in core and it does reach the
 * database's own code: those are the migration and schema tests. Helpers follow the
 * tests that use them. A helper both kinds of test use goes behind
 * `@pertexo/database/testing`, so core's tests need no relative bridge.
 */
function planTestMoves(tree, moves) {
  const prefix = `${DB}/test/`;
  const files = tree.tracked.filter((file) => file.startsWith(prefix));
  const edges = new Map();
  const reachesMoved = new Map();
  const reachesDatabase = new Map();
  for (const file of files.filter(isCode)) {
    const out = [];
    let moved = false;
    let database = false;
    for (const reference of referencesIn(tree, file)) {
      if (reference.specifier.startsWith('.')) {
        const target = tree.resolve(file, reference.specifier);
        if (!target) continue;
        if (target.file.startsWith(prefix)) out.push(target.file);
        else if (target.file.startsWith(`${DB}/src/`)) {
          database = true;
          if (target.file === `${DB}/src/testing.ts`) {
            for (const name of reference.names ?? ['*'])
              if (testingNameMoved(tree, name)) moved = true;
          } else if (tree.movedSource.has(target.file)) moved = true;
        } else if (target.file.startsWith(`${CORE}/`)) moved = true;
      } else if (reference.specifier === '@pertexo/database/testing') {
        database = true;
        for (const name of reference.names ?? ['*'])
          if (testingNameMoved(tree, name)) moved = true;
      } else if (MOVED_DOORS.has(reference.specifier)) moved = true;
      else if (reference.specifier.startsWith('@pertexo/database'))
        database = true;
    }
    edges.set(file, out);
    reachesMoved.set(file, moved);
    reachesDatabase.set(file, database);
  }
  const closure = (start) => {
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const next of edges.get(file) ?? []) visit(next);
    };
    start.forEach(visit);
    return seen;
  };
  const anyInClosure = (file, table) =>
    [...closure([file])].some((reached) => table.get(reached));

  const tests = files.filter(isTestFile);
  const staying = tests.filter((file) => {
    if (anyInClosure(file, reachesMoved)) return false;
    const relative = file.slice(prefix.length);
    if (TEST_FOLDERS_THAT_STAY.some((folder) => relative.startsWith(folder)))
      return true;
    return anyInClosure(file, reachesDatabase);
  });
  const stayingSet = new Set(staying);
  const movingTests = tests.filter((file) => !stayingSet.has(file));
  const stayClosure = closure(staying);
  const moveClosure = closure(movingTests);
  tree.sharedHelpers = [];
  tree.testsStaying = staying;
  for (const file of files) {
    if (isTestFile(file)) {
      if (!stayingSet.has(file))
        moves.set(file, `${CORE}/test/${file.slice(prefix.length)}`);
      continue;
    }
    const inStay = stayClosure.has(file);
    const inMove = moveClosure.has(file);
    if (inStay && inMove) {
      const relative = file.slice(prefix.length).replace(/^support\//u, '');
      moves.set(file, `${DB}/src/testing/${relative}`);
      tree.sharedHelpers.push(file);
    } else if (inMove || !inStay)
      moves.set(file, `${CORE}/test/${file.slice(prefix.length)}`);
  }
}

function testingNameMoved(tree, name) {
  return tree.testingRoutes.get(name) === 'core';
}

/** Each name of the database's test door, and which door it has after the move. */
function readTestingRoutes(tree) {
  const file = `${DB}/src/testing.ts`;
  const routes = new Map();
  for (const statement of tree.parse(file).statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) {
      if (!ts.isEmptyStatement(statement))
        report(
          file,
          `unexpected statement: ${statement.getText().slice(0, 60)}`,
        );
      continue;
    }
    const target = tree.resolve(file, statement.moduleSpecifier.text);
    const route =
      target && tree.movedSource.has(target.file) ? 'core' : 'database';
    const names =
      statement.exportClause && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map((element) => element.name.text)
        : [...tree.exportsOf(target.file).keys()];
    for (const name of names) routes.set(name, route);
  }
  return routes;
}

/** Every place a file names a module or a file next to it. */
function referencesIn(tree, file) {
  const references = [];
  const source = tree.parse(file);
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      references.push({
        kind: ts.isImportDeclaration(node) ? 'import' : 'export',
        node,
        literal: node.moduleSpecifier,
        specifier: node.moduleSpecifier.text,
        names: declaredNames(node),
      });
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal;
      if (ts.isStringLiteralLike(literal))
        references.push({
          kind: 'import-type',
          node,
          literal,
          specifier: literal.text,
          names: node.qualifier ? [firstName(node.qualifier)] : undefined,
        });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
          references.push({
            kind: 'dynamic',
            node,
            literal: argument,
            specifier: argument.text,
            names: dynamicNames(node),
          });
        else if (
          /^vi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)$/u.test(
            callee,
          )
        )
          references.push({
            kind: 'mock',
            node,
            literal: argument,
            specifier: argument.text,
            names: mockedNames(node),
          });
      }
    } else if (
      ts.isNewExpression(node) &&
      node.expression.getText(source) === 'URL' &&
      node.arguments?.length === 2 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[1].getText(source) === 'import.meta.url'
    )
      references.push({
        kind: 'url',
        node,
        literal: node.arguments[0],
        specifier: node.arguments[0].text,
      });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

/** The names read off `await import(...)`, when it's destructured or dotted. */
function dynamicNames(call) {
  let parent = call.parent;
  if (ts.isAwaitExpression(parent)) parent = parent.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    ts.isObjectBindingPattern(parent.name)
  )
    return parent.name.elements.map((element) =>
      (element.propertyName ?? element.name).getText(),
    );
  if (ts.isPropertyAccessExpression(parent)) return [parent.name.text];
  return undefined;
}

function firstName(qualifier) {
  return ts.isIdentifier(qualifier)
    ? qualifier.text
    : firstName(qualifier.left);
}

function declaredNames(node) {
  if (ts.isExportDeclaration(node)) {
    if (!node.exportClause) return undefined;
    if (!ts.isNamedExports(node.exportClause)) return undefined;
    return node.exportClause.elements.map(
      (element) => (element.propertyName ?? element.name).text,
    );
  }
  const clause = node.importClause;
  if (!clause) return undefined;
  if (clause.name) return undefined;
  const bindings = clause.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return undefined;
  return bindings.elements.map(
    (element) => (element.propertyName ?? element.name).text,
  );
}

/** The names a `vi.mock` factory replaces, when it's a plain object literal. */
function mockedNames(call) {
  const factory = call.arguments[1];
  if (!factory || !ts.isArrowFunction(factory)) return undefined;
  let body = factory.body;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  if (!ts.isObjectLiteralExpression(body)) return undefined;
  const names = [];
  for (const property of body.properties) {
    if (ts.isSpreadAssignment(property) || !property.name) return undefined;
    names.push(property.name.getText());
  }
  return names;
}

// ---------------------------------------------------------------------------
// Rewriting: every specifier in every file, in memory
// ---------------------------------------------------------------------------

const workspaceOf = (file) => file.split('/').slice(0, 2).join('/');
const isTestPath = (file) => !/^(?:apps|packages)\/[^/]+\/src\//u.test(file);

function rewriteEverything(tree) {
  const doors = createDoors(tree);
  const generated = new Set([
    `${DB}/src/primitives.ts`,
    `${DB}/src/testing.ts`,
    `${CORE}/src/testing.ts`,
  ]);
  const files = tree.tracked.filter(
    (file) =>
      isCode(file) &&
      /^(?:apps|packages|infrastructure)\//u.test(file) &&
      !generated.has(file),
  );
  // Source first: what core's source needs decides what /primitives holds, and
  // a test then uses that before anything new goes behind /testing.
  const ordered = [
    ...files.filter((file) => !isTestPath(tree.loc(file))),
    ...files.filter((file) => isTestPath(tree.loc(file))),
  ];
  const texts = new Map();
  for (const file of ordered) {
    const text = rewriteFile(tree, doors, file);
    if (text !== tree.text(file)) texts.set(file, text);
  }
  return { texts, doors };
}

function rewriteFile(tree, doors, file) {
  const newFile = tree.loc(file);
  const text = tree.text(file);
  const edits = [];
  const merged = new Map();
  for (const reference of referencesIn(tree, file)) {
    const route = routeReference(tree, doors, file, newFile, reference);
    if (route === undefined) continue;
    if (route.spec !== undefined) {
      if (route.spec === reference.specifier) continue;
      count(route.spec);
      const entry = {
        reference,
        parts: new Map([[route.spec, allElements(reference)]]),
      };
      if (mergeable(reference, route.spec)) addToMerge(merged, entry);
      else edits.push(replaceLiteral(reference.literal, route.spec));
      continue;
    }
    const parts = splitByName(tree, reference, route, file);
    if (parts === undefined) continue;
    const unchanged = parts.size === 1 && parts.has(reference.specifier);
    if (unchanged) continue;
    for (const spec of parts.keys()) count(spec);
    if (parts.size === 1 && !mergeable(reference, [...parts.keys()][0])) {
      edits.push(replaceLiteral(reference.literal, [...parts.keys()][0]));
      continue;
    }
    addToMerge(merged, { reference, parts });
  }
  edits.push(...mergeEdits(merged));
  return applyEdits(text, edits);
}

const stats = { relative: 0, door: 0 };
function count(spec) {
  if (spec.startsWith('.')) stats.relative += 1;
  else stats.door += 1;
}

/** Only statements landing on a shared door merge, so a file doesn't list it ten times. */
function mergeable(reference, spec) {
  return (
    !spec.startsWith('.') &&
    ['import', 'export'].includes(reference.kind) &&
    allElements(reference) !== undefined
  );
}

function allElements(reference) {
  const { node, kind } = reference;
  if (kind === 'import') {
    const clause = node.importClause;
    const bindings = clause?.namedBindings;
    if (!clause || clause.name || !bindings || !ts.isNamedImports(bindings))
      return undefined;
    return bindings.elements.map((element) => element);
  }
  if (kind === 'export') {
    const clause = node.exportClause;
    if (!clause || !ts.isNamedExports(clause)) return undefined;
    return clause.elements.map((element) => element);
  }
  return undefined;
}

function splitByName(tree, reference, route, file) {
  const elements = allElements(reference);
  if (elements === undefined) {
    if (reference.names === undefined) {
      report(
        file,
        `${reference.kind} of ${reference.specifier} needs each name to find its door, and has none to read`,
      );
      return undefined;
    }
    const specs = new Set(reference.names.map((name) => route.byName(name)));
    if (specs.size !== 1) {
      report(
        file,
        `${reference.kind} of ${reference.specifier} would have to split`,
      );
      return undefined;
    }
    return new Map([[[...specs][0], []]]);
  }
  const parts = new Map();
  for (const element of elements) {
    const spec = route.byName((element.propertyName ?? element.name).text);
    if (spec === undefined) return undefined;
    if (!parts.has(spec)) parts.set(spec, []);
    parts.get(spec).push(element);
  }
  return parts;
}

function addToMerge(merged, entry) {
  merged.set(entry.reference, entry);
}

/** Text for statements that split or merge; a lone one-door statement keeps its layout. */
function mergeEdits(merged) {
  const edits = [];
  const groups = new Map();
  for (const { reference, parts } of merged.values())
    for (const [spec, elements] of parts) {
      const typeOnly =
        reference.kind === 'import'
          ? reference.node.importClause?.isTypeOnly === true
          : reference.node.isTypeOnly === true;
      const key = `${reference.kind}|${typeOnly}|${spec}`;
      if (!groups.has(key))
        groups.set(key, {
          kind: reference.kind,
          typeOnly,
          spec,
          elements: [],
          owners: [],
        });
      const group = groups.get(key);
      group.elements.push(...(elements ?? []));
      group.owners.push(reference);
    }
  const statements = new Map();
  for (const group of groups.values()) {
    const owner = group.owners[0];
    if (!statements.has(owner)) statements.set(owner, []);
    statements.get(owner).push(group);
    for (const other of group.owners.slice(1))
      if (!statements.has(other)) statements.set(other, []);
  }
  for (const reference of merged.keys())
    if (!statements.has(reference)) statements.set(reference, []);
  for (const [reference, list] of statements) {
    const { node } = reference;
    const source = node.getSourceFile();
    const start = node.getStart(source);
    let end = node.getEnd();
    if (list.length === 0) {
      if (source.text[end] === '\n') end += 1;
      edits.push({ start, end, text: '' });
      continue;
    }
    const rendered = list
      .map((group) => {
        const verb = group.kind === 'import' ? 'import' : 'export';
        // Inline `type` on every name would leave a side-effect import behind.
        const allTypes = group.elements.every((element) => element.isTypeOnly);
        const type = group.typeOnly || allTypes ? ' type' : '';
        const names = [
          ...new Set(
            group.elements.map((element) =>
              allTypes
                ? element.getText(source).replace(/^type\s+/u, '')
                : element.getText(source),
            ),
          ),
        ];
        return `${verb}${type} { ${names.join(', ')} } from '${group.spec}';`;
      })
      .join('\n');
    edits.push({ start, end, text: rendered });
  }
  return edits;
}

function replaceLiteral(literal, spec) {
  const source = literal.getSourceFile();
  const quote = literal.getText(source)[0];
  return {
    start: literal.getStart(source),
    end: literal.getEnd(),
    text: `${quote}${spec}${quote}`,
  };
}

function applyEdits(text, edits) {
  let result = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

function routeReference(tree, doors, file, newFile, reference) {
  const { specifier, kind } = reference;
  const from = workspaceOf(newFile);
  if (specifier.startsWith('.'))
    return routeRelative(tree, doors, file, newFile, reference);
  if (kind === 'url') return undefined;
  const area = MOVED_DOORS.get(specifier);
  if (area !== undefined) {
    if (from === DB) {
      report(file, `stays in the database but imports ${specifier}`);
      return undefined;
    }
    return {
      spec:
        from === CORE
          ? relativeSpec(newFile, `${CORE}/src/${area}/index.ts`, '.js')
          : `@pertexo/core/${area}`,
    };
  }
  if (specifier === '@pertexo/database/testing')
    return routeTestingDoor(tree, file, newFile, reference);
  if (specifier === '@pertexo/database/primitives')
    return routePrimitives(tree, doors, file, newFile);
  return undefined;
}

function routeRelative(tree, doors, file, newFile, reference) {
  const { specifier, kind } = reference;
  const target = tree.resolve(file, specifier);
  const from = workspaceOf(newFile);
  if (!target) return routeUntracked(tree, file, newFile, specifier);
  const newTarget = tree.loc(target.file);
  const to = workspaceOf(newTarget);
  const crossesToDatabase = from === CORE && to === DB;
  if (newFile === file && newTarget === target.file && !crossesToDatabase)
    return undefined;
  const style = extensionStyle(specifier);
  if (target.dist)
    return { spec: relativeSpec(newFile, distPath(newTarget), '.js') };
  if (kind === 'url' || from === to || (from !== CORE && from !== DB))
    return { spec: relativeSpec(newFile, newTarget, style) };
  if (from === CORE && to === DB) {
    if (kind === 'mock') {
      // A mock must replace the module core really loads, and that's the built one.
      return { spec: relativeSpec(newFile, distPath(newTarget), '.js') };
    }
    if (target.file === `${DB}/src/testing.ts`)
      return routeTestingDoor(tree, file, newFile, reference);
    if (target.file === `${DB}/src/schema.ts`)
      return { spec: '@pertexo/database/schema' };
    if (target.file === `${DB}/src/platform/index.ts`)
      return { spec: '@pertexo/database/platform' };
    return {
      byName: (name) =>
        doors.forName(target.file, name, isTestPath(newFile), file),
    };
  }
  if (from === DB && to === CORE) {
    if (
      newFile.startsWith(`${DB}/src/schema/`) &&
      reference.names?.every((name) => STORED_SHAPE_NAMES.has(name))
    )
      return { spec: relativeSpec(newFile, SHAPES_FILE, style) };
    report(file, `stays in the database but imports ${specifier}, which moves`);
    return undefined;
  }
  return { spec: relativeSpec(newFile, newTarget, style) };
}

/** A folder or built file: nothing to follow, but its path may have to be re-aimed. */
function routeUntracked(tree, file, newFile, specifier) {
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  const folderMoved = [...tree.moves.keys()].some((moved) =>
    moved.startsWith(target.endsWith('/') ? target : `${target}/`),
  );
  const distMoved = /^packages\/(?:database|execution)\/dist\//u.test(target);
  if (folderMoved || distMoved)
    report(file, `${specifier} names a folder or build output that moves`);
  if (newFile === file) return undefined;
  const relative = posix.relative(posix.dirname(newFile), target);
  const trailing = target.endsWith('/') && !relative.endsWith('/') ? '/' : '';
  return {
    spec: `${relative.startsWith('.') ? relative : `./${relative}`}${trailing}`,
  };
}

function routeTestingDoor(tree, file, newFile, reference) {
  const from = workspaceOf(newFile);
  const coreSpec =
    from === CORE
      ? relativeSpec(newFile, `${CORE}/src/testing.ts`, '.js')
      : '@pertexo/core/testing';
  if (reference.kind === 'mock' && reference.names === undefined) {
    report(
      file,
      'mocks @pertexo/database/testing with a factory the script cannot read',
    );
    return undefined;
  }
  return {
    byName: (name) => {
      const route = tree.testingRoutes.get(name);
      if (route === undefined) {
        report(file, `@pertexo/database/testing doesn't export ${name}`);
        return reference.specifier;
      }
      return route === 'core' ? coreSpec : '@pertexo/database/testing';
    },
  };
}

function routePrimitives(tree, doors, file, newFile) {
  const primitives = `${DB}/src/primitives.ts`;
  return {
    byName: (name) => {
      const origin = tree.exportsOf(primitives).get(name);
      if (origin === undefined) {
        report(file, `@pertexo/database/primitives doesn't export ${name}`);
        return '@pertexo/database/primitives';
      }
      const moved = tree.loc(origin.file);
      if (moved.startsWith(`${CORE}/`))
        return relativeSpec(newFile, moved, '.js');
      return doors.forName(origin.file, origin.name, isTestPath(newFile), file);
    },
  };
}

const extensionStyle = (specifier) =>
  /\.(?:js|mjs|ts|tsx|mts|json|sql)$/u.test(specifier)
    ? posix.extname(specifier)
    : '';

function relativeSpec(fromFile, toFile, style) {
  let target = toFile;
  if (style === '.js' || style === '.mjs')
    target = toFile.replace(/\.(?:ts|tsx|mts)$/u, style);
  else if (style === '')
    target = toFile.replace(/\.(?:ts|tsx|mts)$/u, '').replace(/\/index$/u, '');
  const relative = posix.relative(posix.dirname(fromFile), target);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

const distPath = (file) =>
  file.replace(/\/src\//u, '/dist/').replace(/\.(?:ts|tsx)$/u, '.js');

// ---------------------------------------------------------------------------
// Doors: which database entry point a name that stays is reached through
// ---------------------------------------------------------------------------

function createDoors(tree) {
  const schema = `${DB}/src/schema.ts`;
  const platform = `${DB}/src/platform/index.ts`;
  const testing = `${DB}/src/testing.ts`;
  const primitives = new Map();
  const testingAdded = new Map();
  const schemaAdded = new Map();
  const add = (table, name, origin, file) => {
    const existing = table.get(name);
    if (existing && existing.file !== origin.file)
      report(file, `two different exports called ${name} would share a door`);
    table.set(name, origin);
  };
  const same = (door, name, origin) => door.get(name)?.file === origin.file;
  return {
    primitives,
    testingAdded,
    schemaAdded,
    forName(targetFile, name, isTest, file) {
      const origin = tree.exportsOf(targetFile).get(name);
      if (origin === undefined) {
        report(file, `${targetFile} doesn't export ${name}`);
        return '@pertexo/database/primitives';
      }
      const entry = origin.file.startsWith('external:')
        ? { ...origin, file: targetFile, name }
        : origin;
      if (targetFile.startsWith(`${DB}/test/`)) {
        add(testingAdded, name, entry, file);
        return '@pertexo/database/testing';
      }
      if (same(tree.exportsOf(schema), name, origin))
        return '@pertexo/database/schema';
      // A table is the schema's to export, however few people have needed it so far.
      if (origin.file.startsWith(`${DB}/src/schema/`)) {
        add(schemaAdded, name, entry, file);
        return '@pertexo/database/schema';
      }
      if (same(tree.exportsOf(platform), name, origin))
        return '@pertexo/database/platform';
      if (!isTest) {
        add(primitives, name, entry, file);
        return '@pertexo/database/primitives';
      }
      if (primitives.has(name)) return '@pertexo/database/primitives';
      if (
        same(tree.exportsOf(testing), name, origin) &&
        tree.testingRoutes.get(name) === 'database'
      )
        return '@pertexo/database/testing';
      add(testingAdded, name, entry, file);
      return '@pertexo/database/testing';
    },
  };
}

function renderDoorExports(tree, table, doorFile) {
  const byFile = new Map();
  for (const [name, origin] of table) {
    const file = tree.loc(origin.file);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ name, origin });
  }
  return [...byFile.keys()]
    .sort()
    .map((file) => {
      const names = byFile
        .get(file)
        .sort((a, b) => a.name.localeCompare(b.name, 'en'))
        .map(({ name, origin }) => {
          const exported =
            origin.name === name ? name : `${origin.name} as ${name}`;
          return origin.type ? `type ${exported}` : exported;
        });
      return `export { ${names.join(', ')} } from '${relativeSpec(doorFile, file, '.js')}';`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Applying the plan
// ---------------------------------------------------------------------------

function applyMoves(moves) {
  for (const [from, to] of moves) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    git('mv', from, to);
    removeEmptyParents(path.dirname(from));
  }
}

/** Git doesn't track folders; an empty one left behind would look like a leftover. */
function removeEmptyParents(directory) {
  let current = directory;
  while (current !== '.' && fs.readdirSync(current).length === 0) {
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function writeRewrites({ texts }, moves) {
  for (const [file, text] of texts)
    fs.writeFileSync(moves.get(file) ?? file, text);
}

function writeGeneratedFiles(tree, { doors, texts }) {
  const primitivesFile = `${DB}/src/primitives.ts`;
  fs.writeFileSync(
    primitivesFile,
    `// What core areas build on: applications never import this (a check enforces it).\n${renderDoorExports(tree, doors.primitives, primitivesFile)}\n`,
  );
  writeTestingDoors(tree, doors);
  fs.writeFileSync(SHAPES_FILE, STORED_SHAPES);
  fs.mkdirSync(`${CORE}/test/shared`, { recursive: true });
  fs.writeFileSync(
    `${CORE}/test/shared/stored-shapes.test.ts`,
    STORED_SHAPES_TEST,
  );
  const schema = `${DB}/src/schema.ts`;
  fs.writeFileSync(
    schema,
    `${(texts.get(schema) ?? tree.text(schema)).trimEnd()}\n${renderDoorExports(tree, doors.schemaAdded, schema)}\nexport type { ${[...STORED_SHAPE_NAMES].sort().join(', ')} } from './schema/stored-shapes.js';\n`,
  );
  nameFilesOtherAreasReach(tree);
}

/** Split the database's test door: flows go to core's, fixtures stay. */
function writeTestingDoors(tree, doors) {
  const file = `${DB}/src/testing.ts`;
  const coreFile = `${CORE}/src/testing.ts`;
  const database = [];
  const core = [];
  const source = tree.parse(file);
  const header = source.text.slice(0, source.statements[0].getStart(source));
  for (const [position, statement] of source.statements.entries()) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier)
      continue;
    const specifier = statement.moduleSpecifier.text;
    const target = specifier.startsWith('.')
      ? tree.resolve(file, specifier)
      : undefined;
    const moved = target !== undefined && tree.movedSource.has(target.file);
    const newSpec =
      target === undefined
        ? specifier
        : relativeSpec(moved ? coreFile : file, tree.loc(target.file), '.js');
    const rendered = (
      position === 0 ? statement.getText(source) : statement.getFullText(source)
    )
      .replace(`'${specifier}'`, `'${newSpec}'`)
      .replace(/^\n+/u, '');
    (moved ? core : database).push(rendered);
  }
  fs.writeFileSync(
    coreFile,
    `// Flows that exist only for tests go here, never beside an area's public door:\n// production can't load this file (a check enforces it).\n${core.join('\n')}\n`,
  );
  const added = renderDoorExports(tree, doors.testingAdded, file);
  fs.writeFileSync(file, `${header}${database.join('\n')}\n${added}\n`);
}

/**
 * Other areas import a passed area's files directly, and the check wants its index
 * to name those files. `export type {} from` names a file without adding a symbol to
 * the door or a runtime edge, so the index gains no re-export for another area's sake.
 */
function nameFilesOtherAreasReach(tree) {
  const named = new Map();
  const walkFiles = (directory) =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = posix.join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(file) : [file];
    });
  for (const file of walkFiles(`${CORE}/src`).filter(isCode)) {
    const [area] = file.slice(`${CORE}/src/`.length).split('/');
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier?.text.startsWith('.')
      ) {
        const target = posix.normalize(
          posix.join(posix.dirname(file), node.moduleSpecifier.text),
        );
        const [targetArea, ...rest] = target
          .slice(`${CORE}/src/`.length)
          .split('/');
        if (
          ['shared', 'variables'].includes(targetArea) &&
          targetArea !== area &&
          rest.length > 0 &&
          rest.join('/') !== 'index.js' &&
          file !== `${CORE}/src/testing.ts`
        ) {
          if (!named.has(targetArea)) named.set(targetArea, new Set());
          named.get(targetArea).add(rest.join('/'));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const [area, files] of [...named].sort()) {
    const index = `${CORE}/src/${area}/index.ts`;
    const text = fs.readFileSync(index, 'utf8');
    const lines = [...files]
      .sort()
      .filter((name) => !text.includes(`'./${name}'`))
      .map((name) => `export type {} from './${name}';`);
    if (lines.length > 0)
      fs.writeFileSync(
        index,
        `${text.trimEnd()}\n\n// Other areas import these files directly (ADR 091); the door gains nothing.\n${lines.join('\n')}\n`,
      );
  }
}

function removeExecutionPackage() {
  for (const file of git('ls-files', EXECUTION).split('\n').filter(Boolean))
    git('rm', '-q', '-f', file);
  fs.rmSync(EXECUTION, { recursive: true, force: true });
}

function applyTextEdits() {
  for (const { file, from, to } of TEXT_EDITS) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(from)) {
      report(
        file,
        `expected text not found, starting "${from.trim().slice(0, 60)}"`,
      );
      continue;
    }
    fs.writeFileSync(file, text.replace(from, to));
  }
  const eslint = 'eslint.config.mjs';
  let lint = fs.readFileSync(eslint, 'utf8');
  const executionBlock = lint.match(
    /  \{\n    files: \['packages\/execution\/\*\*\/\*\.ts'\],[\s\S]*?\n  \},\n/u,
  );
  if (executionBlock) lint = lint.replace(executionBlock[0], '');
  else report(eslint, "the packages/execution rule wasn't found");
  lint = lint
    .replace(/^\s*'@pertexo\/execution(?:\/\*)?',\n/gmu, '')
    .replaceAll(
      'Import a database area entry point, such as @pertexo/database/runs.',
      'Import a database entry point, such as @pertexo/database/platform.',
    );
  fs.writeFileSync(eslint, lint);
}

function format() {
  git('add', '--all');
  const changed = git('diff', '--cached', '--name-only', '--diff-filter=d')
    .split('\n')
    .filter(Boolean);
  for (let start = 0; start < changed.length; start += 400)
    execFileSync(
      'node_modules/.bin/prettier',
      [
        '--write',
        '--ignore-unknown',
        '--log-level=warn',
        ...changed.slice(start, start + 400),
      ],
      { stdio: 'inherit' },
    );
  updateLockfile();
}

/** Offline when the cache has what the lockfile check wants, as it does on a rerun. */
function updateLockfile() {
  const install = (...flags) =>
    execFileSync(
      'pnpm',
      ['install', '--lockfile-only', '--ignore-scripts', ...flags],
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, CI: 'true' },
      },
    );
  try {
    install('--offline');
  } catch {
    try {
      install('--prefer-offline');
    } catch (error) {
      report(
        'pnpm-lock.yaml',
        `not updated, run \`pnpm install\`: ${error.message}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Package configs: read the imports, write what they say
// ---------------------------------------------------------------------------

function updatePackageConfigs(tree) {
  const manifests = new Map();
  for (const directory of [...listDirs('apps'), ...listDirs('packages')]) {
    const manifest = `${directory}/package.json`;
    if (fs.existsSync(manifest))
      manifests.set(directory, JSON.parse(fs.readFileSync(manifest, 'utf8')));
  }
  const workspaceDirectory = new Map(
    [...manifests].map(([directory, json]) => [json.name, directory]),
  );
  const versions = knownVersions(tree);
  const root = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const rootPackages = { ...root.dependencies, ...root.devDependencies };

  writeCoreManifest(manifests.get(CORE), versions, rootPackages);
  writeDatabaseManifest(manifests.get(DB));
  for (const [directory, manifest] of manifests)
    if (directory.startsWith('apps/'))
      updateApplicationManifest(directory, manifest);
  for (const directory of [CORE, DB, ...manifests.keys()].filter(
    (d) => d !== EXECUTION,
  )) {
    if (
      directory.startsWith('packages/') &&
      directory !== CORE &&
      directory !== DB
    )
      continue;
    writeJson(`${directory}/package.json`, manifests.get(directory));
    updateReferences(directory, manifests.get(directory), workspaceDirectory);
  }

  const coreTestConfig = `${CORE}/tsconfig.test.json`;
  const testConfig = JSON.parse(fs.readFileSync(coreTestConfig, 'utf8'));
  testConfig.compilerOptions.rootDir = '.';
  writeJson(coreTestConfig, testConfig);

  const rootConfig = JSON.parse(fs.readFileSync('tsconfig.json', 'utf8'));
  rootConfig.references = rootConfig.references.filter(
    (reference) => reference.path !== `./${EXECUTION}/tsconfig.json`,
  );
  writeJson('tsconfig.json', rootConfig);
}

function listDirs(parent) {
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);
}

/** Versions come from the manifests the code came from, read before any edit. */
function knownVersions(tree) {
  const versions = new Map();
  for (const file of [
    `${DB}/package.json`,
    `${EXECUTION}/package.json`,
    `${CORE}/package.json`,
  ]) {
    if (!tree.has(file)) continue;
    const json = JSON.parse(
      execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' }),
    );
    for (const kind of ['dependencies', 'devDependencies'])
      for (const [name, version] of Object.entries(json[kind] ?? {}))
        versions.set(name, version);
  }
  return versions;
}

function writeCoreManifest(manifest, versions, rootPackages) {
  const source = readImports(`${CORE}/src`);
  const tests = readImports(`${CORE}/test`);
  const dependencies = {};
  const devDependencies = {};
  const place = (name, table) => {
    if (name === '@pertexo/core') return;
    const version = name.startsWith('@pertexo/')
      ? 'workspace:*'
      : versions.get(name);
    if (version === undefined) {
      if (!Object.hasOwn(rootPackages, name))
        report(`${CORE}/package.json`, `no known version for ${name}`);
      return;
    }
    table[name] = version;
    const types = `@types/${name}`;
    if (versions.has(types)) devDependencies[types] = versions.get(types);
  };
  for (const [name, runtime] of source) {
    if (runtime || name.startsWith('@pertexo/')) place(name, dependencies);
    else place(name, devDependencies);
  }
  for (const name of tests.keys())
    if (!Object.hasOwn(dependencies, name)) place(name, devDependencies);
  // A type's package stays a dev dependency unless the code loads it at runtime.
  for (const name of Object.keys(devDependencies))
    if (Object.hasOwn(dependencies, name)) delete devDependencies[name];
  manifest.dependencies = sortKeys(dependencies);
  manifest.devDependencies = sortKeys(devDependencies);
  manifest.exports = coreExports();
}

function coreExports() {
  const exports = {
    './testing': { types: './dist/testing.d.ts', default: './dist/testing.js' },
  };
  for (const area of listDirs(`${CORE}/src`)
    .map((d) => posix.basename(d))
    .sort()) {
    if (area === 'shared') continue;
    if (!fs.existsSync(`${CORE}/src/${area}/index.ts`)) continue;
    exports[`./${area}`] = {
      types: `./dist/${area}/index.d.ts`,
      default: `./dist/${area}/index.js`,
    };
  }
  return exports;
}

function writeDatabaseManifest(manifest) {
  for (const door of MOVED_DOORS.keys()) {
    const key = door.replace('@pertexo/database/', './');
    delete manifest.exports[key];
  }
  const source = readImports(`${DB}/src`);
  const tests = readImports(`${DB}/test`);
  const used = (name) =>
    source.has(name) ||
    tests.has(name) ||
    name === 'drizzle-kit' ||
    (name.startsWith('@types/') &&
      (source.has(name.slice(7)) || tests.has(name.slice(7))));
  for (const kind of ['dependencies', 'devDependencies'])
    for (const name of Object.keys(manifest[kind] ?? {}))
      if (!used(name)) delete manifest[kind][name];
  // What only tests still use is no longer a runtime dependency.
  for (const name of Object.keys(manifest.dependencies))
    if (!source.has(name)) {
      manifest.devDependencies[name] = manifest.dependencies[name];
      delete manifest.dependencies[name];
    }
  manifest.dependencies = sortKeys(manifest.dependencies);
  manifest.devDependencies = sortKeys(manifest.devDependencies);
}

function updateApplicationManifest(directory, manifest) {
  const source = readImports(`${directory}/src`);
  const others = new Map();
  for (const folder of fs.readdirSync(directory)) {
    if (['src', 'node_modules', 'dist'].includes(folder)) continue;
    for (const [name, runtime] of readImports(`${directory}/${folder}`))
      others.set(name, runtime);
  }
  for (const kind of ['dependencies', 'devDependencies'])
    if (manifest[kind]) delete manifest[kind]['@pertexo/execution'];
  for (const name of ['@pertexo/core', '@pertexo/database']) {
    const wasListed =
      Object.hasOwn(manifest.dependencies ?? {}, name) ||
      Object.hasOwn(manifest.devDependencies ?? {}, name);
    if (manifest.dependencies) delete manifest.dependencies[name];
    if (manifest.devDependencies) delete manifest.devDependencies[name];
    if (source.has(name)) {
      manifest.dependencies ??= {};
      manifest.dependencies[name] = 'workspace:*';
    } else if (
      others.has(name) ||
      (wasListed && name === '@pertexo/database')
    ) {
      if (others.has(name)) {
        manifest.devDependencies ??= {};
        manifest.devDependencies[name] = 'workspace:*';
      }
    }
  }
  for (const kind of ['dependencies', 'devDependencies'])
    if (manifest[kind]) manifest[kind] = sortKeys(manifest[kind]);
}

function updateReferences(directory, manifest, workspaceDirectory) {
  const file = `${directory}/tsconfig.json`;
  if (!fs.existsSync(file)) return;
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const wanted = Object.keys(manifest.dependencies ?? {})
    .filter((name) => workspaceDirectory.has(name))
    .map((name) => workspaceDirectory.get(name));
  const pathTo = (target) =>
    `${posix.relative(directory, target)}/tsconfig.json`;
  const current = (config.references ?? []).map((reference) => reference.path);
  const next = [
    ...current.filter((reference) =>
      wanted.some((target) => pathTo(target) === reference),
    ),
    ...wanted
      .map(pathTo)
      .filter((reference) => !current.includes(reference))
      .sort(),
  ];
  if (next.join() === current.join()) return;
  config.references = next.map((reference) => ({ path: reference }));
  writeJson(file, config);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sortKeys(table) {
  return Object.fromEntries(
    Object.entries(table ?? {}).sort(([a], [b]) => a.localeCompare(b, 'en')),
  );
}

/** package name -> whether any import of it survives type erasure. */
function readImports(start) {
  const packages = new Map();
  const visitFile = (file) => {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file),
    );
    const add = (specifier, runtime) => {
      if (
        specifier.startsWith('.') ||
        specifier.startsWith('node:') ||
        specifier.startsWith('@/')
      )
        return;
      const parts = specifier.split('/');
      const name = specifier.startsWith('@')
        ? parts.slice(0, 2).join('/')
        : parts[0];
      packages.set(name, packages.get(name) === true || runtime);
    };
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier
      )
        add(node.moduleSpecifier.text, isRuntimeStatement(node));
      else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isStringLiteralLike(node.arguments[0])
      )
        add(node.arguments[0].text, true);
      else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      )
        add(node.argument.literal.text, false);
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  const walk = (entry) => {
    if (!fs.existsSync(entry)) return;
    if (fs.statSync(entry).isFile()) {
      if (isCode(entry)) visitFile(entry);
      return;
    }
    for (const child of fs.readdirSync(entry)) {
      if (['node_modules', 'dist'].includes(child)) continue;
      walk(posix.join(entry, child));
    }
  };
  walk(start);
  return packages;
}

function isRuntimeStatement(statement) {
  if (ts.isExportDeclaration(statement)) {
    if (statement.isTypeOnly) return false;
    const clause = statement.exportClause;
    return !(
      clause &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((e) => e.isTypeOnly)
    );
  }
  const clause = statement.importClause;
  if (clause?.isTypeOnly) return false;
  const bindings = clause?.namedBindings;
  return !(
    clause &&
    !clause.name &&
    bindings &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((e) => e.isTypeOnly)
  );
}

// ---------------------------------------------------------------------------
// Reporting and proof
// ---------------------------------------------------------------------------

function printPlan(tree, { texts, doors }) {
  const moves = [...tree.moves];
  const code = (list) => list.filter(([from]) => isCode(from));
  const coreSource = code(
    moves.filter(([, to]) => to.startsWith(`${CORE}/src/`)),
  );
  const coreTests = moves.filter(([, to]) => to.startsWith(`${CORE}/test/`));
  const toDatabase = moves.filter(([, to]) => to.startsWith(`${DB}/`));
  const applicationFiles = [...texts.keys()].filter((file) =>
    file.startsWith('apps/'),
  );
  console.log(`Moved to core/src: ${coreSource.length} files`);
  console.log(`Moved to core/test: ${coreTests.length} files`);
  console.log(
    `Moved within the database: ${toDatabase.map(([from, to]) => `${from} -> ${to}`).join(', ')}`,
  );
  console.log(`Tests that stay in the database: ${tree.testsStaying.length}`);
  for (const test of tree.testsStaying)
    console.log(`  ${test.slice(`${DB}/test/`.length)}`);
  console.log(
    `Helpers both kinds of test use, now behind /testing: ${tree.sharedHelpers.join(', ') || 'none'}`,
  );
  console.log(`Files with a rewritten specifier: ${texts.size}`);
  console.log(
    `  of which in apps: source ${applicationFiles.filter((f) => f.includes('/src/')).length}, tests ${applicationFiles.filter((f) => !f.includes('/src/')).length}`,
  );
  console.log(
    `Specifiers rewritten: relative ${stats.relative}, to a door ${stats.door}`,
  );
  console.log(
    `/primitives exports: ${doors.primitives.size}; added to /schema: ${doors.schemaAdded.size}; added to /testing: ${doors.testingAdded.size}`,
  );
  const moved = (from) =>
    [...tree.tracked].filter((file) => file.startsWith(from));
  for (const area of AREAS)
    console.log(
      `  ${area}: ${moved(`${DB}/src/${area}/`).filter((f) => tree.moves.get(f)?.startsWith(`${CORE}/`)).length} source files, ${moved(`${DB}/test/${area}/`).filter((f) => tree.moves.get(f)?.startsWith(`${CORE}/`)).length} test files`,
    );
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 });
}

/**
 * Compare HEAD with a base: with every module specifier blanked out, each code file's
 * text must exist on both sides, and every test title must still exist. Whatever this
 * prints is every line in the change that isn't an import.
 */
function prove(base) {
  if (!base) throw new Error('Usage: --prove <base-ref>');
  const files = (ref) =>
    git(
      'ls-tree',
      '-r',
      '--name-only',
      ref,
      'apps',
      'packages',
      'infrastructure',
    )
      .split('\n')
      .filter((file) => isCode(file) && !file.startsWith('scripts/'));
  const fingerprint = (ref) => {
    const byHash = new Map();
    const titles = new Map();
    const list = files(ref);
    const texts = readAll(ref, list);
    for (const [position, file] of list.entries()) {
      const hash = createHash('sha256')
        .update(blankSpecifiers(file, texts[position]))
        .digest('hex');
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash).push(file);
      for (const title of testTitles(file, texts[position]))
        titles.set(title, (titles.get(title) ?? 0) + 1);
    }
    return { byHash, titles };
  };
  const before = fingerprint(base);
  const after = fingerprint('HEAD');
  const onlyIn = (a, b) =>
    [...a.byHash]
      .filter(([hash]) => !b.byHash.has(hash))
      .flatMap(([, list]) => list);
  const changedBefore = onlyIn(before, after);
  const changedAfter = onlyIn(after, before);
  console.log(
    `Code files: ${files(base).length} before, ${files('HEAD').length} after`,
  );
  console.log(
    `Files whose text changed beyond specifiers: ${changedBefore.length} before, ${changedAfter.length} after`,
  );
  for (const file of changedBefore) console.log(`  - ${file}`);
  for (const file of changedAfter) console.log(`  + ${file}`);
  const sum = (table) => [...table.values()].reduce((a, b) => a + b, 0);
  console.log(
    `Test titles: ${sum(before.titles)} before, ${sum(after.titles)} after`,
  );
  let lost = 0;
  for (const [title, number] of before.titles) {
    const left = after.titles.get(title) ?? 0;
    if (left < number) {
      lost += number - left;
      console.log(`  LOST ${number - left}x: ${title}`);
    }
  }
  console.log(`Titles lost: ${lost}`);
  for (const [title, number] of after.titles)
    if ((before.titles.get(title) ?? 0) < number)
      console.log(`  added: ${title}`);
  if (lost > 0) process.exitCode = 1;
}

/** Every file's text in one `git cat-file`, rather than a process per file. */
function readAll(ref, list) {
  const output = execFileSync('git', ['cat-file', '--batch'], {
    input: list.map((file) => `${ref}:${file}`).join('\n'),
    maxBuffer: 1 << 30,
  });
  const texts = [];
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(10, offset);
    const size = Number(output.toString('utf8', offset, end).split(' ')[2]);
    texts.push(output.toString('utf8', end + 1, end + 1 + size));
    offset = end + 1 + size + 1;
  }
  return texts;
}

function blankSpecifiers(file, text) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const removals = [];
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier)
    ) {
      removals.push([node.getStart(source), node.getEnd()]);
      return;
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      removals.push([node.argument.getStart(source), node.argument.getEnd()]);
    else if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        /^vi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)$/u.test(
          node.expression.getText(source),
        ))
    )
      removals.push([
        node.arguments[0].getStart(source),
        node.arguments[0].getEnd(),
      ]);
    else if (
      ts.isNewExpression(node) &&
      node.expression.getText(source) === 'URL' &&
      node.arguments?.length === 2 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[1].getText(source) === 'import.meta.url'
    )
      removals.push([
        node.arguments[0].getStart(source),
        node.arguments[0].getEnd(),
      ]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  let result = text;
  for (const [start, end] of removals.sort((a, b) => b[0] - a[0]))
    result = result.slice(0, start) + result.slice(end);
  return result.replace(/\s+/gu, '');
}

function testTitles(file, text) {
  if (!/\/(?:test|e2e|e2e-live)\/|\.test\.mjs$/u.test(file)) return [];
  const titles = [];
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      const argument = node.arguments[0];
      if (/^(?:it|test)(?:\.[a-zA-Z.]+)?$/u.test(callee) && argument)
        titles.push(argument.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return titles;
}

// Last, so every helper above is initialised.
if (mode === '--prove') prove(process.argv[3]);
else run();
