import { describe, expect, it } from 'vitest';
import {
  HTTP_REQUEST_DEFINITION,
  HTTP_REQUEST_MANIFEST,
} from '@pertexo/integrations';

import { PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE } from '../src/registry.js';
import { resolvePlatformNodeDefinitionForRelease } from '../src/server.js';

describe('platform node definition resolution', () => {
  it('resolves exact schemas without constructing or calling an executor', () => {
    const resolved = resolvePlatformNodeDefinitionForRelease(
      PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
      HTTP_REQUEST_DEFINITION,
    );
    expect(resolved.manifest).toStrictEqual(HTTP_REQUEST_MANIFEST);
    expect(
      resolved.configSchema.safeParse({
        method: 'GET',
        url: 'https://provider.example.test/resource',
        headers: {},
        timeoutMillis: 1_000,
        maxRedirects: 1,
        maxResponseBytes: 1_024,
        inlineResponseBytes: 512,
      }).success,
    ).toBe(true);
    expect(() =>
      resolvePlatformNodeDefinitionForRelease(
        PLATFORM_REGISTRY_RELEASE_HTTP_ACTIVE,
        { key: 'missing.node', version: 1 },
      ),
    ).toThrow(/not implemented/u);
  });
});
