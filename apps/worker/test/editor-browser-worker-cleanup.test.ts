import { describe, expect, it, vi } from 'vitest';
import {
  closeEditorBrowserWorker,
  EditorBrowserWorkerShutdownError,
} from './support/editor-browser-worker-cleanup.js';

describe('editor browser worker shutdown ownership', () => {
  it.each(['dispatcher', 'attempts', 'coordinator', 'triggers'] as const)(
    'retains Redis after %s shutdown fails',
    async (phase) => {
      const namespace = { close: vi.fn().mockResolvedValue(undefined) };
      const resources = {
        dispatcher: { close: vi.fn().mockResolvedValue(undefined) },
        attempts: { close: vi.fn().mockResolvedValue(undefined) },
        coordinator: { close: vi.fn().mockResolvedValue(undefined) },
        triggers: [{ close: vi.fn().mockResolvedValue(undefined) }],
        namespace,
      };
      const failure = new Error('private failure data must not become IPC');
      const failing =
        phase === 'triggers' ? resources.triggers[0] : resources[phase];
      failing?.close.mockRejectedValue(failure);
      const error: unknown = await closeEditorBrowserWorker(resources).catch(
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(EditorBrowserWorkerShutdownError);
      expect(error).toMatchObject({ phases: [phase], errors: [failure] });
      expect(resources.attempts.close).toHaveBeenCalledOnce();
      expect(resources.coordinator.close).toHaveBeenCalledOnce();
      expect(namespace.close).not.toHaveBeenCalled();
    },
  );
  it('releases its namespace only after every runtime stops', async () => {
    const order: string[] = [];
    const resource = (name: string) => ({
      close: () => {
        order.push(name);
        return Promise.resolve();
      },
    });
    await closeEditorBrowserWorker({
      dispatcher: resource('dispatcher'),
      attempts: resource('attempts'),
      triggers: [resource('triggers')],
      coordinator: resource('coordinator'),
      namespace: resource('namespace'),
    });
    expect(order).toEqual([
      'dispatcher',
      'triggers',
      'attempts',
      'coordinator',
      'namespace',
    ]);
  });
});
