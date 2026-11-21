import { attemptTokenCountSchema, type ModelUsage } from '@pertexo/node-sdk';
import { z } from 'zod';

export type ReportedModelUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
}>;

// An attempt can make one initial call and one repair.
const MAX_REPORTED_TOKENS = Math.floor(Number.MAX_SAFE_INTEGER / 2);

export function modelUsageReader(input: string, output: string) {
  const count = attemptTokenCountSchema
    .max(MAX_REPORTED_TOKENS)
    .nullable()
    .catch(null);
  const counts = z.object({
    [input]: count,
    [output]: count,
  });
  const envelope = z.object({ usage: counts });
  return (body: unknown): ReportedModelUsage => {
    const parsed = envelope.safeParse(body);
    return {
      inputTokens: parsed.data?.usage[input] ?? null,
      outputTokens: parsed.data?.usage[output] ?? null,
    };
  };
}

export function trackModelUsage(
  model: string,
  observe: ((usage: ModelUsage) => void) | undefined,
) {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let incomplete = false;
  return {
    dispatched() {
      observe?.({ kind: 'incomplete', model, inputTokens, outputTokens });
    },
    received(usage: ReportedModelUsage) {
      inputTokens = addCount(inputTokens, usage.inputTokens);
      outputTokens = addCount(outputTokens, usage.outputTokens);
      incomplete ||= usage.inputTokens === null || usage.outputTokens === null;
      observe?.(
        incomplete || inputTokens === null || outputTokens === null
          ? { kind: 'incomplete', model, inputTokens, outputTokens }
          : { kind: 'complete', model, inputTokens, outputTokens },
      );
    },
  };
}

function addCount(total: number | null, count: number | null): number | null {
  return count === null ? total : (total ?? 0) + count;
}
