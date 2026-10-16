import { boundedCodeText } from '../execution/text.js';
import { createWriteStream, writeSync } from 'node:fs';
import { types } from 'node:util';
import type { CodeTask, CodeErrorCode } from '@pertexo/node-sdk';
import { encodeCodeJson, InvalidCodeOutput } from '../execution/encode.js';
import { createTaskConsole } from '../execution/console.js';
import {
  installModulePolicy,
  cleanCodeGlobals,
  RefusedCodeModule,
} from '../execution/modules.js';
import { readCodeFrame as readFrame } from '@pertexo/node-sdk/server';
import type { ChildBoot } from './boot.js';

const nativeProcess: NodeJS.Process = process;
const getDescriptor = Object.getOwnPropertyDescriptor;
const nativeError = Error.isError.bind(Error);
const proxy = types.isProxy;
const hasOwn = Object.hasOwn;
const maximum = Math.max;
const number = Number;
const toString = String;
// Node 24 lazily formats stack through an accessor. Keep its native getter and
// never call a user-supplied getter, prepareStackTrace, name or message hook.
const stackDescriptor = getDescriptor(new Error(), 'stack');
const read = Reflect.get;
const locationPattern = /pertexo-code\.js:(\d+):(\d+)/u;
const locate = locationPattern.exec.bind(locationPattern);
const prepareStack = (_error: Error, frames: NodeJS.CallSite[]) => {
  let result = '';
  let index = 0;
  while (index < frames.length) {
    const frame = frames[index++];
    if (frame === undefined) continue;
    const file = frame.getFileName() ?? frame.getEvalOrigin();
    if (file === 'pertexo-code.js')
      result +=
        file +
        ':' +
        toString(frame.getLineNumber()) +
        ':' +
        toString(frame.getColumnNumber()) +
        '\n';
  }
  return result;
};
Object.defineProperty(Error, 'prepareStackTrace', {
  value: prepareStack,
  writable: false,
  configurable: false,
});

const AsyncFunction = async function () {
  await Promise.resolve();
}.constructor as new (
  ...args: string[]
) => (
  input: unknown,
  variables: unknown,
  require: (name: string) => unknown,
  console: unknown,
) => Promise<unknown>;
const boot = JSON.parse(nativeProcess.env.CODE_CHILD_BOOT ?? '') as ChildBoot;
const control = createWriteStream('', { fd: 3, autoClose: false });
control.on('error', () => nativeProcess.exit(1));
const captured = createTaskConsole(boot.console, boot.json);
let terminal = false;
const isTerminal = () => terminal;
let phase: 'boot' | 'compile' | 'execute' | 'output' = 'boot';
function send(encoded: string): Promise<void> {
  return new Promise((resolve, reject) => {
    control.write(encoded + '\n', (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
function diagnostic(error: unknown) {
  let message = 'Code execution failed.';
  let line: number | undefined, column: number | undefined;
  if (typeof error === 'object' && error !== null && !proxy(error)) {
    const own = getDescriptor(error, 'message');
    if (
      own !== undefined &&
      hasOwn(own, 'value') &&
      typeof own.value === 'string'
    )
      message = boundedCodeText(own.value, 2048);
    if (nativeError(error)) {
      const ownStack = getDescriptor(error, 'stack');
      const stack: unknown =
        ownStack?.get === stackDescriptor?.get
          ? read(error, 'stack')
          : (ownStack?.value as unknown);
      if (typeof stack === 'string') {
        const location = locate(stack);
        if (location !== null) {
          line = maximum(1, number(location[1]) - 3);
          column = maximum(1, number(location[2]));
        }
      }
    }
  } else if (typeof error === 'string') message = boundedCodeText(error, 2048);
  return {
    logs: [],
    truncated: false,
    error: {
      message,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
    },
  };
}
function memoryFailure(error: unknown): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    proxy(error) ||
    !nativeError(error)
  )
    return false;
  const code = getDescriptor(error, 'code');
  if (
    code !== undefined &&
    hasOwn(code, 'value') &&
    code.value === 'ERR_MEMORY_ALLOCATION_FAILED'
  )
    return true;
  const message = getDescriptor(error, 'message');
  return (
    message !== undefined &&
    hasOwn(message, 'value') &&
    message.value === 'Array buffer allocation failed'
  );
}
async function fail(code: CodeErrorCode, error: unknown): Promise<void> {
  if (terminal) return;
  terminal = true;
  const detail = encodeCodeJson(diagnostic(error), {
    ...boot.json,
    bytes: boot.taskBytes,
  });
  await send(
    '{"kind":"failed","code":' +
      encodeCodeJson(code, boot.json) +
      ',"diagnostics":' +
      detail +
      '}',
  );
  nativeProcess.exit(0);
}
nativeProcess.on('uncaughtException', (error) => {
  void fail('code.runtime_error', error);
});
nativeProcess.on('unhandledRejection', (error) => {
  void fail('code.runtime_error', error);
});
try {
  const require = await installModulePolicy(boot.modules);
  cleanCodeGlobals(captured.console);
  await send('{"kind":"ready"}');
  const task = (await readFrame(
    nativeProcess.stdin,
    boot.taskBytes,
    new AbortController().signal,
  )) as CodeTask;
  Object.freeze(task.variables);
  captured.begin();
  phase = 'compile';
  const execute = new AsyncFunction(
    'input',
    '$vars',
    'require',
    'console',
    '"use strict";\n' + task.code + '\n//# sourceURL=pertexo-code.js',
  );
  phase = 'execute';
  const output = await execute(
    task.input,
    task.variables,
    require,
    captured.console,
  );
  phase = 'output';
  const encoded = encodeCodeJson(output, boot.json);
  if (!isTerminal()) {
    terminal = true;
    await send(
      '{"kind":"succeeded","output":' +
        encoded +
        ',"diagnostics":{"logs":[],"truncated":false}}',
    );
    nativeProcess.exit(0);
  }
} catch (error: unknown) {
  if (phase === 'boot') {
    const detail =
      error instanceof Error
        ? error.message +
          ('resource' in error ? ' ' + String(error.resource) : '')
        : 'Unknown startup error';
    writeSync(2, 'Code process startup: ' + detail.slice(0, 2048) + '\n');
    nativeProcess.exit(1);
  }
  await fail(
    phase === 'compile'
      ? 'code.syntax_error'
      : memoryFailure(error)
        ? 'code.memory_limit'
        : error instanceof RefusedCodeModule
          ? 'code.module_refused'
          : error instanceof InvalidCodeOutput
            ? 'code.output_invalid'
            : 'code.runtime_error',
    error,
  );
}
