import path from 'node:path';

import { repositoryRoot } from './ratchet.mjs';
import { isFunction, isMember, propertyName } from './test-syntax.mjs';

// Test-support modules that export a hand-rolled sleep. A call to one is a
// sleep wherever it is imported; the rule checks each entry still is one.
export const SLEEP_HELPER_EXPORTS = Object.freeze([
  { module: 'apps/worker/test/support/recovery/facts.ts', name: 'delay' },
  {
    module:
      'apps/web/test/features/workspace-variables/usage/check.support.tsx',
    name: 'settle',
  },
]);

const TIMER_MODULES = new Set(['node:timers/promises', 'timers/promises']);

/**
 * Recognises a fixed real-time sleep expression in one file: a promise that
 * a timer resolves, `setTimeout` from `node:timers/promises`, Playwright's
 * `waitForTimeout`, and the file's own or imported sleep helpers.
 */
export function createSleepRecognizer(file) {
  const timerFunctions = new Set();
  const timerNamespaces = new Set();
  const importedHelpers = new Set();
  const namedFunctions = new Map();
  const sleepHelpers = new Set();

  function isSleep(node) {
    if (node?.type === 'NewExpression') return isTimerPromise(node);
    if (node?.type !== 'CallExpression') return false;
    const { callee } = node;
    if (callee.type === 'Identifier')
      return (
        timerFunctions.has(callee.name) ||
        importedHelpers.has(callee.name) ||
        sleepHelpers.has(callee.name)
      );
    if (callee.type !== 'MemberExpression') return false;
    const name = propertyName(callee);
    return (
      name === 'waitForTimeout' ||
      isMember(callee, 'scheduler', 'wait') ||
      (name === 'setTimeout' &&
        callee.object.type === 'Identifier' &&
        timerNamespaces.has(callee.object.name))
    );
  }

  /** Only a sleep: `(ms) => new Promise(r => setTimeout(r, ms))`, also wrapped in `act`. */
  function isSleepOnly(fn) {
    if (!isFunction(fn)) return false;
    if (fn.body.type !== 'BlockStatement') return isSleepEffect(fn.body);
    const [statement, ...rest] = fn.body.body;
    if (rest.length > 0 || statement === undefined) return false;
    if (statement.type === 'ReturnStatement')
      return isSleepEffect(statement.argument);
    return (
      statement.type === 'ExpressionStatement' &&
      isSleepEffect(statement.expression)
    );
  }

  function isSleepEffect(expression) {
    const value =
      expression?.type === 'AwaitExpression' ? expression.argument : expression;
    if (isSleep(value)) return true;
    return (
      value?.type === 'CallExpression' &&
      value.arguments.length === 1 &&
      isSleepOnly(value.arguments[0])
    );
  }

  return {
    isSleep,
    /** A global-timer sleep, which `vi.useFakeTimers()` turns into a fake-time wait. */
    isFakeable: (node) =>
      node?.type === 'NewExpression' && isTimerPromise(node),
    /** Whether a named function of this file only sleeps; call after the traversal. */
    isSleepHelper(fn) {
      resolveHelpers();
      return [...sleepHelpers].some((name) => namedFunctions.get(name) === fn);
    },
    resolveHelpers,
    onImport(node) {
      const source = node.source.value;
      if (TIMER_MODULES.has(source)) {
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier') {
            if (importedName(specifier) === 'setTimeout')
              timerFunctions.add(specifier.local.name);
          } else timerNamespaces.add(specifier.local.name);
        }
        return;
      }
      const target = resolveModule(file, source);
      for (const specifier of node.specifiers)
        if (
          specifier.type === 'ImportSpecifier' &&
          SLEEP_HELPER_EXPORTS.some(
            (helper) =>
              withoutExtension(helper.module) === target &&
              helper.name === importedName(specifier),
          )
        )
          importedHelpers.add(specifier.local.name);
    },
    /** Records `function name() {}` and `const name = () => …` before calls are judged. */
    onFunction(fn) {
      const name =
        fn.type === 'FunctionDeclaration'
          ? fn.id?.name
          : fn.parent?.type === 'VariableDeclarator' &&
              fn.parent.id.type === 'Identifier'
            ? fn.parent.id.name
            : undefined;
      if (name !== undefined) namedFunctions.set(name, fn);
    },
  };

  // A helper may call another helper, so grow the set until it is stable.
  function resolveHelpers() {
    let grew = true;
    while (grew) {
      grew = false;
      for (const [name, fn] of namedFunctions)
        if (!sleepHelpers.has(name) && isSleepOnly(fn)) {
          sleepHelpers.add(name);
          grew = true;
        }
    }
  }
}

function importedName(specifier) {
  return specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : specifier.imported.value;
}

/** The repository-relative module, without extension, that a relative import names. */
function resolveModule(file, source) {
  if (!source.startsWith('.')) return undefined;
  const absolute = path.resolve(
    path.dirname(path.resolve(repositoryRoot, file)),
    source,
  );
  return withoutExtension(
    path.relative(repositoryRoot, absolute).replaceAll('\\', '/'),
  );
}

export function withoutExtension(file) {
  return file.replace(/\.[cm]?[jt]sx?$/u, '');
}

function isSetTimeout(node) {
  return (
    (node.type === 'Identifier' && node.name === 'setTimeout') ||
    isMember(node, 'globalThis', 'setTimeout') ||
    isMember(node, 'window', 'setTimeout')
  );
}

/** `new Promise((resolve) => setTimeout(resolve, ms))` and its block-bodied forms. */
function isTimerPromise(node) {
  if (node.callee.type !== 'Identifier' || node.callee.name !== 'Promise')
    return false;
  const [executor] = node.arguments;
  if (!isFunction(executor)) return false;
  const [resolve] = executor.params;
  if (resolve?.type !== 'Identifier') return false;
  const call = onlyExpression(executor.body);
  if (call?.type !== 'CallExpression' || !isSetTimeout(call.callee))
    return false;
  const [handler] = call.arguments;
  if (handler?.type === 'Identifier') return handler.name === resolve.name;
  const resolved = isFunction(handler) ? onlyExpression(handler.body) : null;
  return (
    resolved?.type === 'CallExpression' &&
    resolved.callee.type === 'Identifier' &&
    resolved.callee.name === resolve.name
  );
}

function onlyExpression(body) {
  if (body?.type !== 'BlockStatement') return body;
  const [statement, ...rest] = body.body;
  return statement?.type === 'ExpressionStatement' && rest.length === 0
    ? statement.expression
    : null;
}
