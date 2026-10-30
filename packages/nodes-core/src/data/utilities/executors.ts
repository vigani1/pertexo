import {
  NodeExecutorFailure,
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { boundedUtilityResult } from './result.js';
import { transformText } from './text/execute.js';
import { formatNumber } from './number/execute.js';
import { transformCrypto } from './crypto/execute.js';
import { transformXml } from './xml/execute.js';
import { extractHtml } from './html/execute.js';
import { signHmac } from './hmac/execute.js';
import type { TextConfig, TextInput } from './text/validation.js';
import type { NumberConfig } from './number/validation.js';
import type { CryptoConfig } from './crypto/validation.js';
import type { XmlConfig } from './xml/validation.js';
import type { HtmlConfig } from './html/validation.js';

type Invocation = NodeExecutionInvocation<unknown, unknown>;
function utilityExecutor(
  key: string,
  execute: (invocation: Invocation) => unknown,
): NodeExecutorRegistration {
  return Object.freeze({
    executor: Object.freeze({ key, version: 1 }),
    execute: async (invocation: Invocation) => {
      try {
        invocation.signal.throwIfAborted();
        const result = await execute(invocation);
        invocation.signal.throwIfAborted();
        return boundedUtilityResult(result);
      } catch (error) {
        if (invocation.signal.aborted)
          throw new NodeExecutorFailure({
            kind: 'canceled',
            errorKind: 'canceled',
            possiblyDispatched: false,
          });
        if (error instanceof NodeExecutorFailure) throw error;
        // Bad input has its own refusal above, so this is a defect of ours;
        // telling the user to check their data would only mislead them.
        throw new NodeExecutorFailure({
          kind: 'failed',
          errorKind: 'internal',
          possiblyDispatched: false,
        });
      }
    },
  });
}
export const UTILITY_EXECUTORS = Object.freeze([
  utilityExecutor('core.text', (i) =>
    transformText(i.config as TextConfig, i.input as TextInput, i.signal),
  ),
  utilityExecutor('core.number', (i) =>
    formatNumber(
      i.config as NumberConfig,
      (i.input as { value: number }).value,
    ),
  ),
  utilityExecutor('core.crypto', (i) =>
    transformCrypto(
      i.config as CryptoConfig,
      (i.input as { value?: string }).value,
    ),
  ),
  utilityExecutor('core.hmac', signHmac),
  utilityExecutor('core.xml', (i) =>
    transformXml(
      i.config as XmlConfig,
      (i.input as { value: unknown }).value,
      i.signal,
    ),
  ),
  utilityExecutor('core.html', (i) =>
    extractHtml(
      i.config as HtmlConfig,
      (i.input as { value: string }).value,
      i.signal,
    ),
  ),
]);
