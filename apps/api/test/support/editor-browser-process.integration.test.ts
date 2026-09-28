import { fork } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ownEditorBrowserProcess } from './editor-browser-process.js';

describe('editor browser shutdown under the integration Vitest pool', () => {
  it('observes actual tsx child exit and absent process group after IPC disposal', async () => {
    const child = fork('test/support/editor-browser-shutdown-probe.ts', [], {
      cwd: import.meta.dirname + '/../..',
      execArgv: ['--import', 'tsx'],
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const owner = ownEditorBrowserProcess(child, 'worker');
    await new Promise<void>((resolve) =>
      child.stdout?.once('data', () => {
        resolve();
      }),
    );
    const result = await owner.close().catch((error: unknown) => error);
    if (result !== undefined) {
      const code =
        typeof result === 'object' && result !== null && 'code' in result
          ? result.code
          : undefined;
      console.log(
        'Isolated shutdown fields',
        JSON.stringify({
          ...owner.diagnostics(),
          code,
          errorInCurrentRealm: result instanceof Error,
        }),
      );
    }
    expect(result).toBeUndefined();
    expect(child.exitCode).toBe(0);
  });
});
