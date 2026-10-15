import { FileInputFailure, type JsonValue } from '@pertexo/node-sdk/server';
import { admitFileValue } from './admit-value.js';

export function parseJsonFile(text: string): JsonValue {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const match =
      error instanceof SyntaxError
        ? / in JSON at position (\d+)(?: \(line \d+ column \d+\))?$/u.exec(
            error.message,
          )
        : null;
    const position =
      match?.[1] === undefined ? undefined : Number(match[1]) + 1;
    throw new FileInputFailure({
      reason: 'json_syntax',
      ...(position === undefined ? {} : { position }),
    });
  }
  return admitFileValue(value);
}
