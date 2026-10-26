import { Readable } from 'node:stream';
import { ARTIFACT_INPUT_MAX_BYTES } from '@pertexo/node-sdk';
import {
  NodeExecutorFailure,
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { CORE_CREATE_FILE_EXECUTOR } from './definition.js';
import { createFileFromPages } from './pages.js';
import { encodeFile } from './encode.js';
import { refuseFileCreation } from './failure.js';
import type {
  CoreCreateFileConfig,
  CoreCreateFileInput,
} from './validation.js';
export const coreCreateFileExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_CREATE_FILE_EXECUTOR,
  execute: async (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    let bytes: Uint8Array | undefined;
    let body: Readable | undefined;
    try {
      const config = invocation.config as CoreCreateFileConfig;
      const input = invocation.input as CoreCreateFileInput;
      if ('inputMode' in config && config.inputMode === 'pages') {
        const artifacts = invocation.runtime?.artifacts;
        if (artifacts === undefined)
          refuseFileCreation(
            'storage',
            'File storage is unavailable. Ask the instance owner to configure it.',
          );
        const reference = await createFileFromPages(
          config,
          input,
          artifacts,
          invocation.signal,
        );
        return { file: { kind: 'artifact' as const, ...reference } };
      }
      if (!('data' in input))
        refuseFileCreation(
          'data',
          'Map a value to Data, or choose From pages and map page references.',
        );
      const encoded = await encodeFile(
        invocation.config as CoreCreateFileConfig,
        input.data,
        invocation.signal,
      );
      bytes = encoded.bytes;
      const artifacts = invocation.runtime?.artifacts;
      if (artifacts === undefined)
        refuseFileCreation(
          'storage',
          'File storage is unavailable. Ask the instance owner to configure it.',
        );
      body = Readable.from([encoded.bytes], { objectMode: false });
      const reference = await artifacts.write({
        body,
        maxBytes: ARTIFACT_INPUT_MAX_BYTES,
        mediaType: encoded.mediaType,
        purpose: 'node-output',
        signal: invocation.signal,
      });
      invocation.signal.throwIfAborted();
      return { file: { kind: 'artifact' as const, ...reference } };
    } catch (error) {
      if (invocation.signal.aborted)
        throw new NodeExecutorFailure({
          kind: 'canceled',
          errorKind: 'canceled',
          possiblyDispatched: false,
        });
      if (error instanceof NodeExecutorFailure) throw error;
      throw new NodeExecutorFailure({
        kind: 'retry',
        errorKind: 'network',
        possiblyDispatched: false,
        safeErrorCode: 'file.create_storage',
        errorSummary:
          'The file could not be saved. Check file storage availability and workspace storage usage before trying again.',
      });
    } finally {
      body?.destroy();
      bytes?.fill(0);
    }
  },
});
