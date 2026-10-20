import type { NodeConfig } from '../draft';

const number = {
  locale: 'en-US',
  grouping: true,
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
};
const configurations: Readonly<
  Record<string, Readonly<Record<string, NodeConfig>>>
> = {
  'core.xml': { parse: { operation: 'parse' }, build: { operation: 'build' } },
  'core.html': {
    text: { operation: 'text', selector: 'a', limit: 100 },
    attribute: {
      operation: 'attribute',
      selector: 'a',
      attribute: 'href',
      limit: 100,
    },
  },
  'core.crypto': {
    hash: { operation: 'hash', algorithm: 'sha256', encoding: 'hex' },
    uuid: { operation: 'uuid' },
    random_id: { operation: 'random_id', length: 24 },
  },
  'core.text': {
    trim: { operation: 'trim' },
    uppercase: { operation: 'uppercase' },
    lowercase: { operation: 'lowercase' },
    replace: { operation: 'replace', all: true },
    split: { operation: 'split' },
    truncate: { operation: 'truncate', length: 100, ellipsis: true },
  },
  'core.number': {
    decimal: { operation: 'decimal', ...number },
    percent: { operation: 'percent', ...number },
    currency: { operation: 'currency', ...number, currency: 'USD' },
  },
};
export function utilityOperationConfig(
  definitionKey: string,
  operation?: string,
): NodeConfig | undefined {
  if (definitionKey === 'core.hmac')
    return { algorithm: 'sha256', encoding: 'hex' };
  const variants = configurations[definitionKey];
  const initial = variants === undefined ? undefined : Object.keys(variants)[0];
  const value = variants?.[operation ?? initial ?? ''];
  return value === undefined ? undefined : structuredClone(value);
}

export const UTILITY_OPERATION_KEYS = Object.freeze(
  Object.keys(configurations),
);
