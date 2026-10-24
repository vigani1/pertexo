import { utf8ByteLength } from '@pertexo/workflow-model';

import {
  FileInputFailure,
  NodeInputValidationError,
} from '@pertexo/node-sdk/server';

import {
  HTTP_REQUEST_LIMITS,
  safeRequestUrl,
  type HttpRequestConfig,
  type HttpRequestInput,
} from '../validation.js';
import {
  fillHttpTemplate,
  HTTP_PLACEHOLDER_NAME,
  HttpPlaceholderError,
  type HttpPlaceholderValue,
} from '../placeholders.js';

import { mergeHeaders } from '../material.js';

import { artifactContentType } from '../read-body.js';
import { failedConfiguration } from './contract.js';

export function requestHeaders(
  input: HttpRequestInput,
  configured: Readonly<Record<string, string>>,
  credential: Readonly<Record<string, string>>,
  multipartContentType: string | undefined,
): Readonly<Record<string, string>> {
  const headers = mergeHeaders(configured, credential, failedConfiguration);
  if (multipartContentType === undefined)
    return artifactContentType(input, headers);
  if (Object.hasOwn(headers, 'content-type'))
    throw new FileInputFailure({ reason: 'multipart_content_type' });
  return { ...headers, 'content-type': multipartContentType };
}

export /**
 * Split the {placeholder} values from the body inputs and fill the address
 * and header values. The filled address keeps the configured origin.
 */
function fillPlaceholders(
  configured: HttpRequestConfig,
  mapped: HttpRequestInput,
): Readonly<{ config: HttpRequestConfig; input: HttpRequestInput }> {
  const values: Record<string, HttpPlaceholderValue> = {};
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mapped)) {
    const placeholderValue =
      key !== 'body' &&
      HTTP_PLACEHOLDER_NAME.test(key) &&
      (typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean');
    if (placeholderValue) values[key] = value;
    else input[key] = value;
  }
  let filled;
  try {
    filled = fillHttpTemplate(configured, values);
  } catch (error) {
    if (error instanceof HttpPlaceholderError)
      throw new NodeInputValidationError(error.message);
    throw error;
  }
  if (
    !safeRequestUrl(filled.url) ||
    utf8ByteLength(filled.url) > HTTP_REQUEST_LIMITS.maxUrlBytes ||
    new URL(filled.url).origin !== new URL(configured.url).origin
  )
    throw new NodeInputValidationError(
      'The filled-in address is too long or no longer a safe address; check the values mapped into it.',
    );
  return {
    config: { ...configured, url: filled.url, headers: filled.headers },
    input: input as HttpRequestInput,
  };
}
