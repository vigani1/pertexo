import { FileInputFailure } from '@pertexo/node-sdk/server';
import { HTTP_REQUEST_LIMITS, type HttpRequestInput } from '../validation.js';
import type {
  HttpMultipartConfig,
  HttpMultipartFile,
  HttpMultipartPart,
} from './validation.js';

export type ResolvedMultipartPart = Readonly<{
  part: HttpMultipartPart;
  value: string | HttpMultipartFile;
}>;

/** Cross-check the already validated config and flat values before any file read. */
export function multipartValues(
  config: HttpMultipartConfig,
  input: HttpRequestInput,
): readonly ResolvedMultipartPart[] {
  const expected = new Set(config.parts.map((part) => part.inputKey));
  if (
    Object.keys(input).length !== expected.size ||
    Object.keys(input).some((key) => !expected.has(key))
  )
    throw new FileInputFailure({ reason: 'multipart_values' });
  let bytes = 0;
  return config.parts.map((part) => {
    const value = input[part.inputKey];
    if (part.kind === 'text') {
      if (typeof value !== 'string')
        throw new FileInputFailure({ reason: 'multipart_values' });
      bytes += Buffer.byteLength(value, 'utf8');
    } else {
      if (typeof value !== 'object' || !('kind' in value))
        throw new FileInputFailure({ reason: 'multipart_values' });
      bytes += value.byteLength;
    }
    if (bytes >= HTTP_REQUEST_LIMITS.maxRequestBodyBytes)
      throw new FileInputFailure({ reason: 'multipart_size' });
    return { part, value };
  });
}
