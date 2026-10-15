import { ARTIFACT_INPUT_MAX_BYTES } from '@pertexo/node-sdk';
import {
  FileInputFailure,
  NodeExecutorFailure,
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CORE_READ_FILE_EXECUTOR } from './definition.js';
import type { CoreReadFileConfig, CoreReadFileInput } from './validation.js';
import { parseJsonFile } from './parse-json.js';
import { parseCsvFile } from './parse-csv.js';

export const coreReadFileExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_READ_FILE_EXECUTOR,
  execute: async (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    const config = invocation.config as CoreReadFileConfig;
    const {
      file: { kind: _kind, ...reference },
    } = invocation.input as CoreReadFileInput;
    if (reference.byteLength > ARTIFACT_INPUT_MAX_BYTES)
      throw new FileInputFailure({ reason: 'file_size' });
    const artifacts = invocation.runtime?.artifacts;
    if (artifacts?.read === undefined)
      throw new FileInputFailure({ reason: 'file_unavailable' });
    let bytes: Uint8Array | undefined;
    try {
      bytes = await artifacts.read({
        reference,
        maxBytes: ARTIFACT_INPUT_MAX_BYTES,
        signal: invocation.signal,
      });
      invocation.signal.throwIfAborted();
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new FileInputFailure({ reason: 'invalid_utf8' });
      }
      return config.format === 'json'
        ? parseJsonFile(text)
        : await parseCsvFile(text, config, invocation.signal);
    } catch (error) {
      if (invocation.signal.aborted)
        throw new NodeExecutorFailure({
          kind: 'canceled',
          errorKind: 'canceled',
          possiblyDispatched: false,
        });
      throw error;
    } finally {
      bytes?.fill(0);
    }
  },
});
