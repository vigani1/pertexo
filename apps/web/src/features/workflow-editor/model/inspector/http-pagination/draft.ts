import {
  httpPaginationSchema,
  type HttpRequestConfig,
} from '@pertexo/integrations';
import { isRecord } from '@pertexo/workflow-model';
import type { NodeConfig } from '../draft';

type Pagination = NonNullable<HttpRequestConfig['pagination']>;
function paginationConfig(value: Pagination): NodeConfig {
  const { outputMode, ...rest } = value;
  return outputMode === undefined ? rest : { ...rest, outputMode };
}
function parsePagination(value: unknown): NodeConfig {
  return paginationConfig(httpPaginationSchema.parse(value));
}
export const paginationModes = [
  { value: 'off', label: 'Off' },
  { value: 'next_link', label: 'Next page link' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'page', label: 'Page number' },
  { value: 'offset', label: 'Offset' },
];
export function paginationValue(config: NodeConfig): NodeConfig | undefined {
  if (!isRecord(config.pagination)) return undefined;
  const parsed = httpPaginationSchema.safeParse(config.pagination);
  return parsed.success ? paginationConfig(parsed.data) : config.pagination;
}
export function paginationForMode(
  mode: string,
  previous: NodeConfig | undefined,
): NodeConfig | undefined {
  const parsed = httpPaginationSchema.safeParse(previous);
  const common = parsed.success
    ? {
        itemsPath: parsed.data.itemsPath,
        maxPages: parsed.data.maxPages,
        delayMillis: parsed.data.delayMillis,
        ...(parsed.data.outputMode === undefined
          ? {}
          : { outputMode: parsed.data.outputMode }),
      }
    : { itemsPath: '$.data' };
  switch (mode) {
    case 'next_link':
      return parsePagination({
        ...common,
        mode,
        source: { kind: 'body', path: '$.next' },
      });
    case 'cursor':
      return parsePagination({
        ...common,
        mode,
        cursorPath: '$.meta.next_cursor',
        parameter: 'cursor',
      });
    case 'page':
      return parsePagination({ ...common, mode, parameter: 'page' });
    case 'offset':
      return parsePagination({
        ...common,
        mode,
        parameter: 'offset',
        step: 100,
      });
    default:
      return undefined;
  }
}
export function paginationDescription(value: NodeConfig): string {
  const bound =
    typeof value.maxPages === 'number'
      ? `up to ${String(value.maxPages)} pages`
      : 'up to the page limit';
  switch (value.mode) {
    case 'next_link':
      return `Follows next-page links until empty, ${bound}.`;
    case 'cursor':
      return `Sends the next cursor until empty, ${bound}.`;
    case 'page':
      return `Increases the page number until an empty page, ${bound}.`;
    case 'offset':
      return `Moves the offset forward until an empty page, ${bound}.`;
    case false:
    case null:
    case true:
    case undefined:
    default:
      return 'Fetches one response.';
  }
}
