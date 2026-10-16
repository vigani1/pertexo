import { boundedCodeText } from './text.js';
import { writeSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { encodeCodeJson, quote, type JsonBounds } from './encode.js';

const byteLength = Buffer.byteLength.bind(Buffer);
const string = String;
export type ConsoleBounds = Readonly<{
  bytes: number;
  lines: number;
  characters: number;
}>;
export function createTaskConsole(bounds: ConsoleBounds, json: JsonBounds) {
  let active = false,
    lines = 0,
    bytes = 0,
    truncated = false;
  const format = (value: unknown) => {
    if (typeof value === 'string') return value;
    if (value === null || typeof value !== 'object')
      return typeof value === 'function' ? '[Function]' : string(value);
    try {
      return encodeCodeJson(value, { ...json, bytes: bounds.bytes });
    } catch {
      return '[Value cannot be shown as bounded JSON]';
    }
  };
  const log = (level: string, values: readonly unknown[]) => {
    if (!active || truncated) return;
    let message = '',
      clipped = false;
    for (let index = 0; index < values.length; index++) {
      if (index > 0) message += ' ';
      message += format(values[index]);
      if (message.length > bounds.characters) {
        message = boundedCodeText(message, bounds.characters);
        clipped = true;
        break;
      }
    }
    const size = byteLength(message, 'utf8');
    if (lines >= bounds.lines || bytes + size > bounds.bytes) {
      truncated = true;
      writeSync(1, '{"truncated":true}\n');
      return;
    }
    lines++;
    bytes += size;
    writeSync(
      1,
      '{"level":' + quote(level) + ',"message":' + quote(message) + '}\n',
    );
    if (clipped) writeSync(1, '{"truncated":true}\n');
  };
  return {
    begin: () => {
      active = true;
    },
    console: Object.freeze({
      log: (...values: unknown[]) => {
        log('log', values);
      },
      info: (...values: unknown[]) => {
        log('info', values);
      },
      warn: (...values: unknown[]) => {
        log('warn', values);
      },
      error: (...values: unknown[]) => {
        log('error', values);
      },
      debug: (...values: unknown[]) => {
        log('debug', values);
      },
    }),
  };
}
