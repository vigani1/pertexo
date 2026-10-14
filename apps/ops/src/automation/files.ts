import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { AutomationCommandError } from './errors.js';

export const MAX_COMMAND_BYTES = 2 * 1_024 * 1_024;

export async function readCommandJson(path: string): Promise<unknown> {
  try {
    // Nonblocking open lets us reject a FIFO/device before it can hang the CLI.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_COMMAND_BYTES)
        throw new AutomationCommandError(
          'cli.invalid_file',
          'Use a regular JSON file no larger than 2 MB.',
        );
      const buffer = Buffer.alloc(MAX_COMMAND_BYTES + 1);
      let length = 0;
      while (length <= MAX_COMMAND_BYTES) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_COMMAND_BYTES)
        throw new AutomationCommandError(
          'cli.invalid_file',
          'The JSON file exceeds 2 MB.',
        );
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, length),
      );
      return JSON.parse(text) as unknown;
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (cause instanceof AutomationCommandError) throw cause;
    throw new AutomationCommandError(
      'cli.invalid_file',
      'The input file could not be read as bounded UTF-8 JSON.',
    );
  }
}
