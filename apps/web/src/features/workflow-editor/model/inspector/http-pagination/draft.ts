import {
  httpPaginationSchema,
  type HttpRequestConfig,
} from '@pertexo/integrations';
import { isRecord } from '@pertexo/workflow-model';
import { withConfigValue, type NodeConfig } from '../draft';
import type { NodeFormApi } from '../node-form';

type Pagination = NonNullable<HttpRequestConfig['pagination']>;
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
  return parsed.success ? parsed.data : config.pagination;
}
export function paginationForMode(
  mode: string,
  previous: NodeConfig | undefined,
): Pagination | undefined {
  const parsed = httpPaginationSchema.safeParse(previous);
  const common = parsed.success
    ? {
        itemsPath: parsed.data.itemsPath,
        maxPages: parsed.data.maxPages,
        delayMillis: parsed.data.delayMillis,
      }
    : { itemsPath: '$.data' };
  switch (mode) {
    case 'next_link':
      return httpPaginationSchema.parse({
        ...common,
        mode,
        source: { kind: 'body', path: '$.next' },
      });
    case 'cursor':
      return httpPaginationSchema.parse({
        ...common,
        mode,
        cursorPath: '$.meta.next_cursor',
        parameter: 'cursor',
      });
    case 'page':
      return httpPaginationSchema.parse({ ...common, mode, parameter: 'page' });
    case 'offset':
      return httpPaginationSchema.parse({
        ...common,
        mode,
        parameter: 'offset',
        step: 100,
      });
    default:
      return undefined;
  }
}
/** Nested fields edit the current draft, preserving sibling edits made since render. */
export function nestedConfigForm(form: NodeFormApi, key: string): NodeFormApi {
  return {
    ...form,
    reportScratch: (field, scratch) => {
      form.reportScratch(`${key}:${field}`, scratch);
    },
    commit: (update, coalesceKey) => {
      form.commit((node) => {
        const child = isRecord(node.config[key])
          ? (node.config[key] as NodeConfig)
          : {};
        const change =
          typeof update === 'function'
            ? update({ ...node, config: child })
            : update;
        return change.config === undefined
          ? {}
          : { config: withConfigValue(node.config, key, change.config) };
      }, `${key}:${coalesceKey}`);
    },
  };
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
    default:
      return 'Fetches one response.';
  }
}
