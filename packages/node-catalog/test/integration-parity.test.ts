import { describe, expect, it } from 'vitest';
import {
  PLATFORM_NODE_CATALOG,
  PlatformNodeDefinitionUnavailableError,
  connectionFormCatalog,
  findConnectionDefinition,
  platformBrowserNodeDefinitionCatalog,
  resolvePlatformNodeDefinition,
} from '../src/index.js';
import {
  platformPortableDefinitionPolicy,
  resolvePlatformPollFetcher,
} from '../src/server.js';
import { createPlatformNodeRegistry } from './platform-registry.fixture.js';

describe('integration registry parity', () => {
  it('projects and resolves the same pinned definitions and executors', () => {
    const catalog = PLATFORM_NODE_CATALOG.definitions;
    const browser = platformBrowserNodeDefinitionCatalog().definitions;
    const registry = createPlatformNodeRegistry();

    expect(browser.map(({ definition }) => definition)).toEqual(
      expect.arrayContaining(catalog.map(({ definition }) => definition)),
    );
    expect(browser).toHaveLength(catalog.length);
    expect(
      browser
        .filter(({ presentation }) => presentation !== undefined)
        .map(({ definition }) => definition),
    ).toEqual(
      expect.arrayContaining(
        [
          'database.execute',
          'database.poll',
          'email.send_notification',
          'http.poll',
          'http.request',
          'slack.send_message',
        ].map((key) => ({ key, version: 1 })),
      ),
    );

    for (const manifest of catalog) {
      const { definition, executor, executorAbi } = manifest;
      const projection = browser.find(
        (item) =>
          item.definition.key === definition.key &&
          item.definition.version === definition.version,
      );
      expect(resolvePlatformNodeDefinition(definition).manifest).toEqual(
        manifest,
      );
      if (manifest.integration !== undefined) {
        expect(projection).toMatchObject({
          integration: manifest.integration,
          presentation: {
            name: expect.any(String) as unknown,
            icon: expect.any(String) as unknown,
          },
        });
      }
      if (executor !== undefined) {
        const dispatch = registry.dispatchMode({ definition, executor });
        expect(dispatch).toBe(
          executorAbi === 2 ? 'executor_controlled' : 'before_execute',
        );
      }
    }
  });

  it('resolves only registered versions of polling triggers', () => {
    for (const key of ['http.poll', 'database.poll']) {
      expect(resolvePlatformPollFetcher({ key, version: 1 })).toBeTypeOf(
        'function',
      );
      expect(() => resolvePlatformPollFetcher({ key, version: 2 })).toThrow(
        PlatformNodeDefinitionUnavailableError,
      );
    }
    expect(() =>
      resolvePlatformPollFetcher({ key: 'http.request', version: 1 }),
    ).toThrow(PlatformNodeDefinitionUnavailableError);
  });

  it('serves a connection form for every credential accepted by portable slots', () => {
    for (const { slots } of platformPortableDefinitionPolicy().definitions) {
      for (const slot of slots) {
        for (const authType of slot.acceptedAuthTypes) {
          expect(
            findConnectionDefinition(authType, slot.providerKey),
          ).toMatchObject({
            slot: { key: slot.slot },
          });
          expect(connectionFormCatalog).toContainEqual(
            expect.objectContaining({
              providerKey: slot.providerKey,
              authType,
              slot: slot.slot,
            }),
          );
        }
      }
    }
  });
});
