import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/node-sdk';
import { COLLECTION_MAX_ITEMS } from '../../lists/semantics/validation.js';
import { refuseUtility } from '../result.js';
import type { TextConfig, TextInput } from './validation.js';

export function transformText(
  config: TextConfig,
  input: TextInput,
  signal: AbortSignal,
) {
  const { value } = input;
  switch (config.operation) {
    case 'uppercase':
      return { value: value.toLocaleUpperCase('en-US') };
    case 'lowercase':
      return { value: value.toLocaleLowerCase('en-US') };
    case 'trim':
      return { value: value.trim() };
    case 'truncate': {
      const chars = Array.from(value);
      return {
        value:
          chars.length <= config.length
            ? value
            : chars
                .slice(0, config.length - (config.ellipsis ? 1 : 0))
                .join('') + (config.ellipsis ? '…' : ''),
      };
    }
    case 'replace': {
      if (
        input.search === undefined ||
        input.search === '' ||
        input.replacement === undefined
      )
        return refuseUtility(
          'text_fields',
          'Replace needs nonempty search text and a replacement value.',
        );
      let count = 0;
      for (let offset = 0; ;) {
        signal.throwIfAborted();
        const next = value.indexOf(input.search, offset);
        if (next < 0) break;
        count++;
        offset = next + input.search.length;
        if (!config.all) break;
      }
      const bytes =
        Buffer.byteLength(value) +
        count *
          (Buffer.byteLength(input.replacement) -
            Buffer.byteLength(input.search));
      if (bytes > STORED_EXECUTION_VALUE_LIMITS.inlineBytes)
        return refuseUtility(
          'result_too_large',
          'Replacement would exceed the step data limits. Split the text first.',
        );
      return {
        value: config.all
          ? value.replaceAll(input.search, () => input.replacement ?? '')
          : value.replace(input.search, () => input.replacement ?? ''),
      };
    }
    case 'split': {
      if (input.delimiter === undefined || input.delimiter === '')
        return refuseUtility(
          'text_fields',
          'Split needs a nonempty delimiter.',
        );
      const values: string[] = [];
      let offset = 0;
      for (;;) {
        signal.throwIfAborted();
        const next = value.indexOf(input.delimiter, offset);
        values.push(value.slice(offset, next < 0 ? undefined : next));
        if (values.length > COLLECTION_MAX_ITEMS)
          return refuseUtility(
            'too_many_items',
            'Split produces too many items. Split the input into smaller batches.',
          );
        if (next < 0) return { value: values };
        offset = next + input.delimiter.length;
      }
    }
  }
}
