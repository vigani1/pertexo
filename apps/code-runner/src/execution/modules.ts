import { codeTextSlice, codeTextStartsWith } from './text.js';
import { createRequire, isBuiltin, registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';

export class RefusedCodeModule extends Error {}
export type ModulePolicy = Readonly<{
  builtins: readonly string[];
  packages: readonly string[];
  roots: readonly string[];
  readPaths: readonly string[];
}>;
const includes = (values: readonly string[], value: string) => {
  let index = 0;
  while (index < values.length) if (values[index++] === value) return true;
  return false;
};
const rootOf = (value: string) => {
  for (let index = 0; index < value.length; index++)
    if (value[index] === '/') return codeTextSlice(value, 0, index);
  return value;
};
const inRoots = (value: string, roots: readonly string[]) => {
  let index = 0;
  while (index < roots.length) {
    const root = roots[index++];
    if (root !== undefined && owned(value, root)) return true;
  }
  return false;
};
const owned = (value: string, root: string) =>
  value === root || codeTextStartsWith(value, root + sep);

/** Both require and import use this policy, including package dependencies. */
export async function installModulePolicy(policy: ModulePolicy) {
  const require = createRequire(import.meta.url);
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.length > 512)
        throw new RefusedCodeModule('Use an allowed module name.');
      const normalized: string = codeTextStartsWith(specifier, 'node:')
        ? codeTextSlice(specifier, 5)
        : specifier;
      if (isBuiltin(specifier)) {
        const root = rootOf(normalized);
        if (includes(policy.builtins, root)) return next(specifier, context);
        throw new RefusedCodeModule(
          'This Node module is not available in Code steps.',
        );
      }
      const trustedParent =
        context.parentURL !== undefined &&
        codeTextStartsWith(context.parentURL, 'file:') &&
        inRoots(fileURLToPath(context.parentURL), policy.roots);
      let allowedPackage = false;
      let index = 0;
      while (index < policy.packages.length) {
        const name = policy.packages[index++];
        if (
          name !== undefined &&
          (specifier === name || codeTextStartsWith(specifier, name + '/'))
        )
          allowedPackage = true;
      }
      if (!trustedParent && !allowedPackage)
        throw new RefusedCodeModule(
          'This module is not in the instance allowlist.',
        );
      const resolved = next(specifier, context);
      if (
        !codeTextStartsWith(resolved.url, 'file:') ||
        !inRoots(realpathSync(fileURLToPath(resolved.url)), policy.roots)
      )
        throw new RefusedCodeModule(
          'Code steps can load only installed allowed packages.',
        );
      return resolved;
    },
  });
  for (const name of policy.packages) await import(name);
  return (specifier: string): unknown => {
    if (typeof specifier !== 'string' || specifier.length > 512)
      throw new RefusedCodeModule('Use an allowed module name.');
    const normalized: string = codeTextStartsWith(specifier, 'node:')
      ? codeTextSlice(specifier, 5)
      : specifier;
    const root = rootOf(normalized);
    let accepted = isBuiltin(specifier) && includes(policy.builtins, root);
    if (!isBuiltin(specifier)) {
      let index = 0;
      while (index < policy.packages.length) {
        const name = policy.packages[index++];
        if (
          name !== undefined &&
          (specifier === name || codeTextStartsWith(specifier, name + '/'))
        )
          accepted = true;
      }
    }
    if (!accepted)
      throw new RefusedCodeModule(
        'This module is not in the instance allowlist.',
      );
    // Use the public package specifier. No cache, resolve, main or loader handle escapes.
    return require(specifier) as unknown;
  };
}

/** Only harmless JS/Web globals survive, including in Function constructors. */
export function cleanCodeGlobals(capturedConsole: unknown): void {
  const allowed = new Set([
    'globalThis',
    'Infinity',
    'NaN',
    'undefined',
    'Object',
    'Function',
    'Boolean',
    'Symbol',
    'Number',
    'BigInt',
    'Math',
    'Date',
    'String',
    'RegExp',
    'Array',
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float16Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
    'ArrayBuffer',
    'SharedArrayBuffer',
    'DataView',
    'Atomics',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'WeakRef',
    'FinalizationRegistry',
    'JSON',
    'Promise',
    'Reflect',
    'Proxy',
    'Intl',
    'WebAssembly',
    'Error',
    'AggregateError',
    'EvalError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'TypeError',
    'URIError',
    'eval',
    'parseInt',
    'parseFloat',
    'isNaN',
    'isFinite',
    'decodeURI',
    'decodeURIComponent',
    'encodeURI',
    'encodeURIComponent',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'queueMicrotask',
    'structuredClone',
    'URL',
    'URLSearchParams',
    'TextEncoder',
    'TextDecoder',
    'AbortController',
    'AbortSignal',
    'DOMException',
    'atob',
    'btoa',
    'ReadableStream',
    'WritableStream',
    'TransformStream',
    'ByteLengthQueuingStrategy',
    'CountQueuingStrategy',
    'Blob',
    'File',
    'FormData',
    'console',
  ]);
  for (const key of Reflect.ownKeys(globalThis))
    if (typeof key === 'string' && !allowed.has(key))
      Reflect.deleteProperty(globalThis, key);
  Object.defineProperty(globalThis, 'console', {
    value: capturedConsole,
    writable: false,
    configurable: false,
  });
}
