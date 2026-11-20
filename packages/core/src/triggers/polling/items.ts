import { createHash } from 'node:crypto';
import {
  canonicalJson,
  type JsonValue,
  type HttpPollConfig,
} from '@pertexo/workflow-model';

export const POLL_MAX_ITEMS = 100;
export const POLL_MAX_PAGES = 5;
export const POLL_MAX_SEEN_KEYS = 10 * POLL_MAX_ITEMS;

export type PollItem = Readonly<{ key: string | number; item: JsonValue }>;
export type FetchPoll = (
  input: Readonly<{
    workspaceId: string;
    triggerId: string;
    config: HttpPollConfig;
    seenKeys: readonly string[];
    maxItems: number;
    maxPages: number;
    signal: AbortSignal;
  }>,
) => Promise<readonly PollItem[]>;

export function newPollItems(
  items: readonly PollItem[],
  seen: readonly string[],
) {
  const keys = new Set(seen);
  const ordered = [];
  for (const { key, item } of items.slice(0, POLL_MAX_ITEMS)) {
    const hash = createHash('sha256').update(canonicalJson(key)).digest('hex');
    if (keys.has(hash)) continue;
    keys.add(hash);
    ordered.push({ hash, item });
  }
  return ordered.reverse();
}
