import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const forbiddenAreas = new Set([
  'database',
  'integrations',
  'secrets',
  'worker',
]);
const forbiddenGlobals = new Set([
  'fetch',
  'WebSocket',
  'EventSource',
  'XMLHttpRequest',
  'navigator',
  'process',
  'global',
  'globalThis',
  'window',
  'self',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'queueMicrotask',
  'performance',
  'crypto',
  'eval',
  'Function',
  'require',
  'module',
]);

function sourceFile(file) {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

function visit(node, inspect) {
  if (inspect(node) === false) return;
  ts.forEachChild(node, (child) => visit(child, inspect));
}

function importTarget(specifier, file, root) {
  if (isBuiltin(specifier) || specifier.startsWith('node:'))
    throw new Error(`Node builtin ${specifier}`);
  let candidate;
  if (specifier.startsWith('.')) {
    candidate = resolve(dirname(file), specifier);
  } else {
    const [, area, entry = ''] =
      /^@pertexo\/([^/]+)(.*)$/u.exec(specifier) ?? [];
    if (area === undefined || forbiddenAreas.has(area) || entry !== '/pure')
      throw new Error(`forbidden package ${specifier}`);
    const packageRoot = join(root, 'packages', area);
    const { exports } = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    );
    const exported = exports?.[`.${entry}`];
    if (
      exported?.types !== './dist/pure.d.ts' ||
      exported.default !== './dist/pure.js' ||
      Object.keys(exported).length !== 2
    )
      throw new Error(`invalid pure entry ${specifier}`);
    candidate = join(packageRoot, 'src/pure.ts');
  }
  const target = realpathSync(
    candidate.replace(/(?:\.d)?\.js$/u, '.ts').replace(/\.d\.ts$/u, '.ts'),
  );
  const [scope, area] = relative(root, target).split('/');
  const [, importer] = relative(root, file).split('/');
  if (
    scope !== 'packages' ||
    forbiddenAreas.has(area) ||
    (specifier.startsWith('.') && area !== importer)
  )
    throw new Error(`forbidden source path ${specifier}`);
  return target;
}

function explicitDateUse(node) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node)
    return ['parse', 'UTC'].includes(parent.name.text);
  if (!ts.isNewExpression(parent) || parent.expression !== node) return false;
  const first = parent.arguments?.[0];
  return first !== undefined && !ts.isSpreadElement(first);
}

export function checkInlineClosure(root, entries) {
  const seen = new Set();
  function check(file) {
    if (seen.has(file)) return;
    seen.add(file);
    visit(sourceFile(file), (node) => {
      const reject = (reason) => {
        throw new Error(`${relative(root, file)}: ${reason}`);
      };
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.isTypeOnly || node.importClause?.isTypeOnly) return false;
        if (node.moduleSpecifier === undefined) return;
        let target;
        try {
          target = importTarget(node.moduleSpecifier.text, file, root);
        } catch (error) {
          reject(error.message);
        }
        check(target);
        return false;
      }
      if (
        ts.isImportEqualsDeclaration(node) ||
        node.kind === ts.SyntaxKind.ImportKeyword
      )
        reject('dynamic import or require');
      if (
        (ts.isPropertyAccessExpression(node) &&
          node.name.text === 'constructor') ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteral(node.argumentExpression) &&
          node.argumentExpression.text === 'constructor')
      )
        reject('indirect Function constructor');
      if (!ts.isIdentifier(node)) return;
      if (forbiddenGlobals.has(node.text)) reject(`forbidden API ${node.text}`);
      if (node.text === 'Date' && !explicitDateUse(node))
        reject('Date requires explicit input');
      if (
        node.text === 'Math' &&
        !(
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.expression === node &&
          node.parent.name.text !== 'random'
        )
      )
        reject('Math.random or indirect Math access');
    });
  }
  for (const file of entries) check(file);
}

export function checkCoreInlineBindings(root) {
  root = realpathSync(root);
  const coreSource = join(root, 'packages/nodes-core/src');
  const entries = new Set();
  for (const area of readdirSync(join(root, 'packages'))) {
    const manifestPath = join(root, 'packages', area, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.exports?.['./pure'] === undefined) continue;
    entries.add(importTarget(`@pertexo/${area}/pure`, manifestPath, root));
  }
  for (const name of readdirSync(coreSource, { recursive: true })) {
    if (!name.endsWith('.ts')) continue;
    const file = join(coreSource, name);
    const source = sourceFile(file);
    const imported = new Map();
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node)) continue;
      const bindings = node.importClause?.namedBindings;
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements)
        imported.set(binding.name.text, node.moduleSpecifier.text);
    }
    visit(source, (node) => {
      if (
        (!ts.isPropertyAssignment(node) &&
          !ts.isShorthandPropertyAssignment(node) &&
          !ts.isMethodDeclaration(node)) ||
        node.name.getText(source).replace(/['"]/gu, '') !== 'executeInline'
      )
        return;
      const binding = ts.isShorthandPropertyAssignment(node)
        ? node.name
        : node.initializer;
      const specifier =
        binding && ts.isIdentifier(binding)
          ? imported.get(binding.text)
          : undefined;
      if (specifier === undefined || !specifier.startsWith('.'))
        throw new Error(
          `${relative(root, file)}: executeInline must bind a named import from a kernel module`,
        );
      entries.add(importTarget(specifier, file, root));
    });
  }
  checkInlineClosure(root, entries);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  checkCoreInlineBindings(
    resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  );
