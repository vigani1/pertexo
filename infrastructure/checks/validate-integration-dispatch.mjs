import process from 'node:process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

import {
  listSourceFiles,
  readSource,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';

const catalog = 'packages/node-catalog/src/';
const discovery = 'packages/integrations/src/modules.ts';
const catalogRegistry = `${catalog}integration-modules.ts`;
const worker = 'apps/worker/src/';
const web = 'apps/web/src/features/';
const contracts = 'packages/contracts/src/schemas/connections/';
const dispatchFiles = [
  'packages/integrations/src/server.ts',
  catalogRegistry,
  ...['catalog', 'browser-catalog', 'portable-definition-policy', 'server'].map(
    (name) => `${catalog}${name}.ts`,
  ),
  ...[
    'providers/connections',
    'providers/node-registry',
    'attempts/delivery/executor-failure',
    'triggers/fetch-poll',
    'triggers/fetch-http-poll',
    'triggers/trigger.runtime',
  ].map((name) => `${worker}${name}.ts`),
  ...[
    'catalog/model/steps/registry.ts',
    'catalog/model/steps/presentation.ts',
    'connections/model/connection-providers.ts',
    'connections/model/connection-health.ts',
    'connections/components/provider-tile.tsx',
    'connections/components/connection-test/panel.tsx',
  ].map((name) => web + name),
  ...['connection-credentials', 'connection-fields', 'connections'].map(
    (name) => `${contracts}${name}.ts`,
  ),
  'packages/database/src/schema/connections.ts',
];

const protocolImports = new Set([
  'OAuth2TokenFailure',
  'createProviderHttpClient',
]);

// Protocol-specific adapters and UI copy share these tags with integration keys.
const protocolUses = new Map([
  [
    catalogRegistry,
    ["test.kind === 'oauth2'", ...Array(2).fill("test.kind === 'http'")],
  ],
  [
    `${worker}providers/connections.ts`,
    [
      "expectedProviderKey: 'http'",
      "resolved.connection.authType === 'http_headers'",
      "resolved.connection.authType !== 'oauth2'",
      "authType: 'http_headers'",
      "authType: 'oauth2'",
      "providerKey: 'http'",
    ],
  ],
  [
    `${worker}providers/node-registry.ts`,
    ['smtp: dependencies.smtp ?? createSmtpEmailClient(smtpPolicy)'],
  ],
  [`${web}connections/model/connection-providers.ts`, ["test === 'smtp'"]],
  [
    `${web}connections/model/connection-health.ts`,
    [
      ...copyKeys('REJECTED_CREDENTIAL', 'signing postgres http'),
      ...copyKeys('SUCCESS_TITLES', 'signing postgres http smtp oauth2'),
      ...copyKeys('REJECTED_HELP', 'postgres signing http'),
      ...Array(4).fill("definition.test === 'http'"),
      "definition.test === 'signing'",
      "definition.test === 'postgres'",
      "definition.test === 'oauth2'",
      "protocol === 'smtp'",
      "protocol === 'oauth2'",
    ],
  ],
  [
    `${web}connections/components/connection-test/panel.tsx`,
    [
      ...copyKeys('INTRO', 'postgres signing http smtp oauth2'),
      "test !== 'http'",
      "definition.test === 'signing'",
      "definition.test === 'oauth2'",
    ],
  ],
  [`${contracts}connections.ts`, ["z.literal('smtp')"]],
]);

function copyKeys(owner, keys) {
  return keys.split(' ').map((key) => `${owner}.${key}`);
}

function variableOwner(node) {
  let parent = node.parent;
  while (parent !== undefined) {
    if (ts.isVariableDeclaration(parent)) return parent.name.getText();
    parent = parent.parent;
  }
  return undefined;
}

function useSignature(use, node) {
  if (ts.isArrayLiteralExpression(use))
    return `${variableOwner(use)}.${node.text}`;
  if (ts.isObjectLiteralExpression(use.parent) && use.name === node) {
    const owner = variableOwner(use);
    if (owner !== undefined) return `${owner}.${node.text}`;
  }
  return use.getText();
}

function walk(file, text, visit) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const traverse = (node) => {
    visit(node, source);
    ts.forEachChild(node, traverse);
  };
  traverse(source);
}

export function integrationKeys(sources) {
  const keys = new Set();
  for (const [file, text] of sources)
    walk(file, text, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ['key', 'authType'].includes(node.name.getText()) &&
        ts.isStringLiteralLike(node.initializer) &&
        (!file.endsWith('/connections.definition.ts') ||
          node.name.getText() !== 'key')
      )
        keys.add(node.initializer.text);
    });
  return keys;
}

function registrationImport(file, node) {
  const source = node.moduleSpecifier;
  if (!source || !ts.isStringLiteralLike(source)) return false;
  if (source.text.endsWith('.module.js') && file !== discovery) return true;
  const integration = /^@pertexo\/integrations(?:\/|$)/u.test(source.text);
  const workflow = source.text === '@pertexo/workflow-model';
  if (!integration && !workflow) return false;
  if (node.isTypeOnly || node.importClause?.isTypeOnly) return false;
  const bindings = node.importClause?.namedBindings ?? node.exportClause;
  if (bindings === undefined || !('elements' in bindings)) return integration;
  return bindings.elements.some((binding) => {
    const name = (binding.propertyName ?? binding.name).text;
    if (binding.isTypeOnly || protocolImports.has(name)) return false;
    if (
      file === catalogRegistry &&
      source.text === '@pertexo/integrations/server' &&
      name === 'INTEGRATION_MODULES'
    )
      return false;
    return (
      integration ||
      name === 'CONNECTION_AUTH_TYPE' ||
      /(?:_POLL_TRIGGER|_CONNECTION_SLOT)$/u.test(name)
    );
  });
}

function providerKey(node, keys) {
  if (ts.isStringLiteralLike(node) || ts.isIdentifier(node)) {
    const key = node.text;
    return keys.has(key) || keys.has(key.replace(/@\d+$/u, ''));
  }
  return false;
}

function literalUse(node, keys) {
  if (ts.isTaggedTemplateExpression(node) && node.tag.getText() === 'sql') {
    return [...node.template.getText().matchAll(/'([a-z][a-z0-9_.]*)'/gu)].some(
      ([, key]) => keys.has(key),
    )
      ? node
      : undefined;
  }
  if (!providerKey(node, keys)) return undefined;
  const parent = node.parent;
  if (
    ts.isStringLiteralLike(node) &&
    ts.isPropertyAssignment(parent) &&
    parent.initializer === node &&
    ((parent.name.getText() === 'protocol' &&
      ['http', 'postgres', 'smtp'].includes(node.text)) ||
      (parent.name.getText() === 'transport' && node.text === 'smtp'))
  )
    return undefined;
  if (
    ts.isIdentifier(node) &&
    !(ts.isPropertyAssignment(parent) && parent.name === node)
  )
    return undefined;
  return parent;
}

export function findIntegrationDispatch(file, text, keys) {
  if (!dispatchFiles.includes(file)) return [];
  const findings = [];
  const permitted = [...(protocolUses.get(file) ?? [])];
  walk(file, text, (node, source) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (registrationImport(file, node)) record(node, source);
      return;
    }
    const use = literalUse(node, keys);
    if (use !== undefined) {
      const allowance = permitted.indexOf(useSignature(use, node));
      if (allowance === -1) record(node, source, use.getText());
      else permitted.splice(allowance, 1);
    }
  });
  return findings;

  function record(node, source, detail = node.getText()) {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    findings.push(
      `${file}:${String(line + 1)}: use the integration registry for ${detail}`,
    );
  }
}

export async function inspectIntegrationDispatch(root = repositoryRoot) {
  const declarations = [
    ...(await listSourceFiles('packages/integrations', root)).filter((file) =>
      /(?:\.module|\.definition)\.ts$/u.test(file),
    ),
    'packages/workflow-model/src/triggers/polling.schemas.ts',
  ];
  const keys = integrationKeys(
    await Promise.all(
      declarations.map(async (file) => [file, await readSource(file, root)]),
    ),
  );
  const triggerFiles = await readdir(path.join(root, worker, 'triggers'));
  const findings = await Promise.all(
    dispatchFiles
      .filter(
        (file) =>
          !file.endsWith('/fetch-http-poll.ts') ||
          triggerFiles.includes('fetch-http-poll.ts'),
      )
      .map(async (file) =>
        findIntegrationDispatch(file, await readSource(file, root), keys),
      ),
  );
  return findings.flat();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  report(
    await inspectIntegrationDispatch(),
    'Integration dispatch uses the module registry.',
  );
