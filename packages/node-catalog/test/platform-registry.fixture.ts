import { vi } from 'vitest';
import {
  createPlatformNodeRegistry as assemble,
  type PlatformNodeRegistryDependencies,
} from '../src/server.js';
export function createPlatformNodeRegistry(
  dependencies: Partial<PlatformNodeRegistryDependencies> = {},
) {
  return assemble({
    ...dependencies,
    httpClient: dependencies.httpClient ?? {
      executeStreaming: vi.fn(),
      redactText: vi.fn((value: string) => value),
    },
    fixedEndpointHttpClient: dependencies.fixedEndpointHttpClient ?? {
      execute: vi.fn(),
    },
    slackSendMessage: dependencies.slackSendMessage ?? {
      client: { sendMessage: vi.fn() },
    },
    emailSendNotification: dependencies.emailSendNotification ?? {
      client: { sendNotification: vi.fn() },
    },
  });
}
