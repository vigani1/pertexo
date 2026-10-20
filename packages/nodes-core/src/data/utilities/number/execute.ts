import type { NumberConfig } from './validation.js';

export function formatNumber(config: NumberConfig, value: number) {
  return {
    value: new Intl.NumberFormat(config.locale, {
      style: config.operation,
      ...(config.operation === 'currency' ? { currency: config.currency } : {}),
      useGrouping: config.grouping,
      minimumFractionDigits: config.minimumFractionDigits,
      maximumFractionDigits: config.maximumFractionDigits,
    }).format(value),
  };
}
