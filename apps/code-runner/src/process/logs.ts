import { retainCodeText } from './diagnostics.js';
import { StringDecoder } from 'node:string_decoder';
import {
  CODE_LIMITS,
  codeDiagnosticsSchema,
  type CodeDiagnostics,
} from '@pertexo/node-sdk';

const lineSchema = codeDiagnosticsSchema.shape.logs.element;
export function captureTaskLogs(exceeded: () => void) {
  const decoder = new StringDecoder('utf8');
  const logs: CodeDiagnostics['logs'] = [];
  let pending = '',
    wire = 0,
    bytes = 0,
    truncated = false;
  return {
    append(chunk: Buffer) {
      wire += chunk.length;
      if (wire > 512 * 1024) {
        truncated = true;
        exceeded();
        return;
      }
      pending += decoder.write(chunk);
      for (;;) {
        const at = pending.indexOf('\n');
        if (at === -1) {
          if (pending.length > 16 * 1024) {
            pending = '';
            truncated = true;
            exceeded();
          }
          return;
        }
        const text = pending.slice(0, at);
        pending = pending.slice(at + 1);
        let value: unknown;
        try {
          value = JSON.parse(text) as unknown;
        } catch {
          truncated = true;
          continue;
        }
        const line = lineSchema.safeParse(value);
        if (!line.success) {
          truncated = true;
          continue;
        }
        const retained = retainCodeText(
          line.data.message,
          CODE_LIMITS.logLineCharacters,
        );
        truncated ||= retained.truncated;
        const size = Buffer.byteLength(retained.message);
        if (
          logs.length >= CODE_LIMITS.logLines ||
          bytes + size > CODE_LIMITS.logBytes
        ) {
          truncated = true;
          continue;
        }
        logs.push({ ...line.data, message: retained.message });
        bytes += size;
      }
    },
    snapshot: (): CodeDiagnostics => ({ logs: [...logs], truncated }),
  };
}
