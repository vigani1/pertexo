import type { ExecutorIdentity } from '@pertexo/node-sdk';
import { NodeInputValidationError } from '@pertexo/node-sdk/server';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { executeHttpRequest } from '../http/request/lifecycle.js';
import { HTTP_REQUEST_LIMITS } from '../http/request/request.schemas.js';
import {
  prepareInvocation,
  type RequestConnectionBinding,
} from '../http/request/execution/invocation.js';
import { registerProviderExecutor } from '../providers/provider-executor.js';
import type { IntegrationExecutorDependencies } from '../providers/integration-module.js';
import { readJsonPointer } from '../http/read-json-pointer.js';
import { pathInputName, type CommunityAction } from './manifest.schemas.js';

type RecipeInputs = Readonly<Record<string, string | number | boolean>>;

export function createRecipeExecutor(
  { httpClient }: IntegrationExecutorDependencies,
  executor: ExecutorIdentity,
  {
    origin,
    action,
    binding,
  }: Readonly<{
    origin: string;
    action: CommunityAction;
    binding: RequestConnectionBinding | undefined;
  }>,
) {
  return registerProviderExecutor(executor, undefined, async (invocation) => {
    const values = invocation.input as RecipeInputs;
    const path = action.path
      .split('/')
      .map((segment) => {
        const key = pathInputName(segment);
        return key === undefined ? segment : encodeSegment(String(values[key]));
      })
      .join('/');
    const url = new URL(path, origin);
    for (const [name, value] of mappedInputs(action.query, values))
      url.searchParams.set(name, String(value));
    if (utf8ByteLength(url.href) > HTTP_REQUEST_LIMITS.maxUrlBytes)
      throw new NodeInputValidationError(
        'The mapped request address exceeds the HTTP URL limit.',
      );
    const body =
      action.body === undefined
        ? undefined
        : {
            encoding: 'utf8' as const,
            value: JSON.stringify(
              Object.fromEntries(mappedInputs(action.body, values)),
            ),
          };
    const response = await executeHttpRequest(
      httpClient,
      prepareInvocation(
        invocation,
        {
          config: {
            url: url.href,
            method: action.method,
            headers:
              body === undefined ? {} : { 'content-type': 'application/json' },
            timeoutMillis: HTTP_REQUEST_LIMITS.defaultTimeoutMillis,
            maxRedirects: 0,
            maxResponseBytes: HTTP_REQUEST_LIMITS.defaultInlineResponseBytes,
            inlineResponseBytes: HTTP_REQUEST_LIMITS.defaultInlineResponseBytes,
          },
          input: body === undefined ? {} : { body },
        },
        binding,
        origin,
      ),
    );
    const json =
      'body' in response && response.body.kind === 'inline'
        ? response.body.json
        : undefined;
    if (action.projection === 'body') return json;
    return Object.fromEntries(
      Object.entries(action.projection).flatMap(([key, pointer]) => {
        const value = readJsonPointer(json, pointer);
        return value === undefined ? [] : [[key, value]];
      }),
    );
  });
}

function mappedInputs(mapping: CommunityAction['query'], values: RecipeInputs) {
  return Object.entries(mapping ?? {}).flatMap(([name, { input }]) => {
    const value = Object.hasOwn(values, input) ? values[input] : undefined;
    return value === undefined ? [] : [[name, value] as const];
  });
}

function encodeSegment(value: string): string {
  if (
    value === '' ||
    value === '.' ||
    value === '..' ||
    /[/\\%]/u.test(value) ||
    !value.isWellFormed()
  )
    throw new NodeInputValidationError(
      'A mapped path value must fit in one URL segment.',
    );
  return encodeURIComponent(value);
}
