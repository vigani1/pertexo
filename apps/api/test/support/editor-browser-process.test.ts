import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { ownEditorBrowserProcess } from './editor-browser-process.js';

describe('editor browser process shutdown proof', () => {
  it('preserves the fixture at the deadline when every group poll remains EPERM', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM',()=>process.send({phase:'worker-shutdown',success:true},()=>process.exit(0)));setInterval(()=>{},1000);console.log('ready')`,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore', 'ipc'] },
    );
    const owner = ownEditorBrowserProcess(child, 'worker', {
      graceMs: 20,
      killMs: 50,
    });
    await new Promise<void>((resolve) =>
      child.stdout?.once('data', () => {
        resolve();
      }),
    );
    const kill = process.kill.bind(process);
    const probe = vi
      .spyOn(process, 'kill')
      .mockImplementation((pid, signal) => {
        if (pid === -(child.pid ?? 0)) {
          if (signal === 0)
            throw Object.assign(new Error('Unconfirmed group'), {
              code: 'EPERM',
            });
          // Simulated persistent group visibility; do not signal a reused PID.
          if (signal === 'SIGKILL') return true;
        }
        return kill(pid, signal);
      });
    const removeFixture = vi.fn();
    try {
      await expect(owner.close().then(removeFixture)).rejects.toThrow(
        'group exit unconfirmed',
      );
      expect(removeFixture).not.toHaveBeenCalled();
      expect(owner.diagnostics()).toMatchObject({
        stage: 'group-deadline',
        acknowledged: true,
        exitCode: 0,
      });
    } finally {
      probe.mockRestore();
      await delay(100);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise<void>((resolve) =>
          child.once('exit', () => {
            resolve();
          }),
        );
      }
    }
  });
  it.each(['SIGTERM', 'SIGKILL'] as const)(
    'rejects EPERM for the mutation signal %s',
    async (signalDenied) => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('ready')`,
        ],
        { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const owner = ownEditorBrowserProcess(child, 'vite', {
        graceMs: 20,
        killMs: 100,
      });
      await new Promise<void>((resolve) =>
        child.stdout.once('data', () => {
          resolve();
        }),
      );
      const kill = process.kill.bind(process);
      const denied = Object.assign(new Error('Mutation permission denied'), {
        code: 'EPERM',
      });
      const probe = vi
        .spyOn(process, 'kill')
        .mockImplementation((pid, signal) => {
          if (pid === -(child.pid ?? 0) && signal === signalDenied)
            throw denied;
          return kill(pid, signal);
        });
      try {
        await expect(owner.close()).rejects.toBe(denied);
        expect(owner.diagnostics().stage).toBe(
          signalDenied === 'SIGTERM' ? 'signal-term' : 'signal-kill',
        );
      } finally {
        probe.mockRestore();
        child.kill('SIGKILL');
        await new Promise<void>((resolve) =>
          child.once('exit', () => {
            resolve();
          }),
        );
      }
    },
  );
  it('waits through an unconfirmed EPERM poll, then requires acknowledgment and actual exit', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM',()=>process.send({phase:'worker-shutdown',success:true},()=>process.exit(0)));setInterval(()=>{},1000);console.log('ready')`,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore', 'ipc'] },
    );
    const owner = ownEditorBrowserProcess(child, 'worker');
    await new Promise<void>((resolve) =>
      child.stdout?.once('data', () => {
        resolve();
      }),
    );
    const kill = process.kill.bind(process);
    let denied = false;
    const probe = vi
      .spyOn(process, 'kill')
      .mockImplementation((pid, signal) => {
        if (pid === -(child.pid ?? 0) && signal === 0 && !denied) {
          denied = true;
          throw Object.assign(new Error('Poll permission unavailable'), {
            code: 'EPERM',
          });
        }
        return kill(pid, signal);
      });
    try {
      await expect(owner.close()).resolves.toBeUndefined();
      expect(denied).toBe(true);
      expect(owner.diagnostics()).toMatchObject({
        stage: 'disposed',
        acknowledged: true,
        exitCode: 0,
      });
    } finally {
      probe.mockRestore();
      await delay(100);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise<void>((resolve) =>
          child.once('exit', () => {
            resolve();
          }),
        );
      }
    }
  });
  it('rejects a failed worker even after its process group disappears', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(1)'], {
      detached: true,
      stdio: 'ignore',
    });
    const owner = ownEditorBrowserProcess(child, 'worker');
    await new Promise<void>((resolve) =>
      child.once('exit', () => {
        resolve();
      }),
    );
    await expect(owner.close()).rejects.toThrow(
      /Worker shutdown was not successful/u,
    );
  });
  it('requires a worker acknowledgment, not only exit zero', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      detached: true,
      stdio: 'ignore',
    });
    const owner = ownEditorBrowserProcess(child, 'worker');
    await new Promise<void>((resolve) =>
      child.once('exit', () => {
        resolve();
      }),
    );
    await expect(owner.close()).rejects.toThrow(
      /Worker shutdown was not successful/u,
    );
    expect(owner.diagnostics().stage).toBe('worker-proof');
  });
  it('rejects an explicit failed worker acknowledgment even with exit zero', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM',()=>process.send({phase:'worker-shutdown',success:false,failures:['attempts']},()=>process.exit(0)));setInterval(()=>{},1000);console.log('ready')`,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore', 'ipc'] },
    );
    const owner = ownEditorBrowserProcess(child, 'worker');
    await new Promise<void>((resolve) =>
      child.stdout?.once('data', () => {
        resolve();
      }),
    );
    await expect(owner.close()).rejects.toThrow(
      /Worker shutdown was not successful/u,
    );
    expect(child.exitCode).toBe(0);
  });
  it('reports only bounded shutdown diagnostics, never raw failure values', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM',()=>process.send({phase:'worker-shutdown',success:false,failures:['redis-namespace','secret-do-not-report']},()=>process.exit(1)));setInterval(()=>{},1000);console.log('ready')`,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore', 'ipc'] },
    );
    const owner = ownEditorBrowserProcess(child, 'worker');
    await new Promise<void>((resolve) =>
      child.stdout?.once('data', () => {
        resolve();
      }),
    );
    const error = await owner.close().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('"exitCode":1');
    expect((error as Error).message).toContain('"phases":["redis-namespace"]');
    expect((error as Error).message).not.toContain('secret-do-not-report');
  });
  it('permits intentional Vite termination without worker acknowledgment', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000); console.log("ready")'],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const owner = ownEditorBrowserProcess(child, 'vite');
    await new Promise<void>((resolve) =>
      child.stdout.once('data', () => {
        resolve();
      }),
    );
    await expect(owner.close()).resolves.toBeUndefined();
    expect(child.signalCode).toBe('SIGTERM');
  });
  it('requires acknowledged successful worker shutdown and exit zero together', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM',()=>process.send({phase:'worker-shutdown',success:true},()=>process.exit(0)));setInterval(()=>{},1000);console.log('ready')`,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore', 'ipc'] },
    );
    const owner = ownEditorBrowserProcess(child, 'worker');
    await new Promise<void>((resolve) =>
      child.stdout?.once('data', () => {
        resolve();
      }),
    );
    await expect(owner.close()).resolves.toBeUndefined();
    expect(child.exitCode).toBe(0);
  });
  it('reaps its private group before reporting forced Vite termination', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('ready');`,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const owner = ownEditorBrowserProcess(child, 'vite', {
      graceMs: 100,
      killMs: 2_000,
    });
    await new Promise<void>((resolve) =>
      child.stdout.once('data', () => {
        resolve();
      }),
    );
    await expect(owner.close()).rejects.toThrow(
      /forced termination after confirmed group reaping/u,
    );
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(owner.diagnostics().stage).toBe('forced-exit');
  });
  it('preserves the fixture when a short-lived intermediate leaves an unacknowledged detached child', async () => {
    const middle = `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);process.exit(0);`;
    const root = `const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:['ignore','pipe','ignore']});c.stdout.on('data',d=>process.stdout.write(d));c.on('exit',()=>process.exit(0));`;
    const child = spawn(process.execPath, ['-e', root], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const owner = ownEditorBrowserProcess(child, 'browser');
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve();
      });
    });
    const detachedPid = await new Promise<number>((resolve) => {
      child.stdout.once('data', (chunk: Buffer) => {
        resolve(Number(chunk.toString().trim()));
      });
    });
    try {
      await exited;
      expect(() => process.kill(detachedPid, 0)).not.toThrow();
      const deleteFixture = vi.fn();
      await expect(owner.close().then(deleteFixture)).rejects.toThrow(
        /Browser shutdown is unconfirmed/u,
      );
      expect(deleteFixture).not.toHaveBeenCalled();
    } finally {
      // Only the PID explicitly issued by this fault fixture, never ps guesses.
      process.kill(detachedPid, 'SIGTERM');
      await delay(100);
      expect(() => process.kill(detachedPid, 0)).toThrow();
    }
  });
  it('accepts an explicit browser-disposal receipt instead of inferring closure', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      detached: true,
      stdio: 'ignore',
    });
    const owner = ownEditorBrowserProcess(child, 'browser', {
      browserDisposed: () => true,
    });
    await new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve();
      });
    });
    await expect(owner.close()).resolves.toBeUndefined();
  });
});
