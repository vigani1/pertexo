import { describe, expect, it, vi } from 'vitest';
import {
  closeEditorBrowserWorker,
  EditorBrowserWorkerShutdownError,
} from './cleanup.js';

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
      capabilities: resource('capabilities'),
      controlledHttp: resource('http'),
      envelopeKeys: resource('keys'),
      namespace: resource('namespace'),
    });
    expect(order).toEqual([
      'dispatcher',
      'triggers',
      'attempts',
      'coordinator',
      'capabilities',
      'http',
      'keys',
      'namespace',
    ]);
  });
  it('does not tear down credentials or target until attempts drain successfully', async () => {
    const capabilities = { close: vi.fn().mockResolvedValue(undefined) };
    const controlledHttp = { close: vi.fn().mockResolvedValue(undefined) };
    const envelopeKeys = { close: vi.fn().mockResolvedValue(undefined) };
    const namespace = { close: vi.fn().mockResolvedValue(undefined) };
    await expect(
      closeEditorBrowserWorker({
        attempts: { close: () => Promise.reject(new Error('uncertain drain')) },
        capabilities,
        controlledHttp,
        envelopeKeys,
        namespace,
      }),
    ).rejects.toThrow(EditorBrowserWorkerShutdownError);
    expect(capabilities.close).not.toHaveBeenCalled();
    expect(controlledHttp.close).not.toHaveBeenCalled();
    expect(envelopeKeys.close).not.toHaveBeenCalled();
    expect(namespace.close).not.toHaveBeenCalled();
  });
  it.each(['capabilities', 'controlledHttp', 'envelopeKeys'] as const)(
    'retains namespace when owned HTTP dependency %s fails close',
    async (key) => {
      const namespace = { close: vi.fn().mockResolvedValue(undefined) };
      const resources = {
        capabilities: { close: vi.fn().mockResolvedValue(undefined) },
        controlledHttp: { close: vi.fn().mockResolvedValue(undefined) },
        envelopeKeys: { close: vi.fn().mockResolvedValue(undefined) },
      };
      resources[key].close.mockRejectedValue(new Error('private details'));
      await expect(
        closeEditorBrowserWorker({ ...resources, namespace }),
      ).rejects.toThrow(EditorBrowserWorkerShutdownError);
      expect(namespace.close).not.toHaveBeenCalled();
    },
  );
});
