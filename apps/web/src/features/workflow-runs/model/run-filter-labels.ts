import { formatDate, formatDateTime } from '@/lib/format-time';
import type { RunPresetRange, RunSearch } from './run-search';
import { describeRunStatus, describeTrigger } from './run-status';

type RunFilterChipKey =
  'workflowId' | 'workflowNamePrefix' | 'status' | 'time' | 'trigger';

export type RunFilterChip = Readonly<{ key: RunFilterChipKey; label: string }>;

const presetLabels: Readonly<Record<RunPresetRange, string>> = {
  '1h': 'Last hour',
  '6h': 'Last 6 hours',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

export function presetRangeLabel(range: RunPresetRange): string {
  return presetLabels[range];
}

/** "Last 24 hours", "Sep 14 – Sep 16, 2026", or undefined for any time. */
export function timeRangeLabel(search: RunSearch): string | undefined {
  const { createdAtFrom: from, createdAtBefore: before, range } = search;
  if (from === undefined && before === undefined) return undefined;
  if (range !== undefined && range !== 'custom') return presetLabels[range];
  const lastDay =
    before === undefined
      ? undefined
      : new Date(Date.parse(before) - 1).toISOString();
  if (from !== undefined && lastDay !== undefined) {
    const start = formatDate(from);
    const end = formatDate(lastDay);
    return start === end ? start : `${start} – ${end}`;
  }
  if (from !== undefined)
    return range === 'custom'
      ? `Since ${formatDate(from)}`
      : `Since ${formatDateTime(from)}`;
  return `Until ${formatDate(lastDay)}`;
}

/** One removable chip per applied filter; the time bounds share one chip. */
export function runFilterChips(
  search: RunSearch,
  workflowName: string | undefined,
): readonly RunFilterChip[] {
  const chips: RunFilterChip[] = [];
  if (search.workflowId !== undefined)
    chips.push({
      key: 'workflowId',
      label: `Workflow: ${workflowName ?? 'selected workflow'}`,
    });
  if (search.workflowNamePrefix !== undefined)
    chips.push({
      key: 'workflowNamePrefix',
      label: `Name: ${search.workflowNamePrefix}`,
    });
  if (search.status !== undefined)
    chips.push({
      key: 'status',
      label: `Status: ${describeRunStatus(search.status).label}`,
    });
  const time = timeRangeLabel(search);
  if (time !== undefined) chips.push({ key: 'time', label: `When: ${time}` });
  if (search.trigger !== undefined)
    chips.push({
      key: 'trigger',
      label: `Trigger: ${describeTrigger(search.trigger)}`,
    });
  return chips;
}
