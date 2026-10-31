import { spawn, type ChildProcess } from 'node:child_process';

import { repositoryRoot } from './environment.js';

export type ExitRecord = Readonly<{
  at: number;
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

const LEVEL_ORDER = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const RESTART_DELAY_MS = 2_000;

export type LogLine = Readonly<{ level: string; text: string }>;

// Structured logs carry pino's numeric levels; last-resort lines on stderr carry names.
const PINO_LEVELS: Readonly<Record<number, string>> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

function parseLine(text: string): LogLine {
  try {
    const { level } = JSON.parse(text) as { level?: unknown };
    if (typeof level === 'number')
      return { level: PINO_LEVELS[level] ?? 'info', text };
    return { level: typeof level === 'string' ? level : 'info', text };
  } catch {
    return { level: 'info', text };
  }
}

/** A real compiled service process, restarted the way compose's `unless-stopped` does. */
export class ServiceProcess {
  public readonly exits: ExitRecord[] = [];
  public readonly starts: number[] = [];
  public readonly logs: LogLine[] = [];
  private child: ChildProcess | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private restarting = false;

  public constructor(
    private readonly entrypoint: string,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  public get pid(): number | undefined {
    return this.child?.pid;
  }

  public get alive(): boolean {
    return this.child !== undefined;
  }

  /** Starts the process, and restarts it after any exit until `stop`. */
  public start(): void {
    this.restarting = true;
    this.spawnOnce();
  }

  /** Starts one process that nothing restarts, for a test that watches its exit. */
  public startOnce(): void {
    this.restarting = false;
    this.spawnOnce();
  }

  public async waitForLog(pattern: RegExp, limitMs: number): Promise<void> {
    const deadline = Date.now() + limitMs;
    const firstLine = this.logs.length;
    while (!this.logs.slice(firstLine).some(({ text }) => pattern.test(text))) {
      if (Date.now() > deadline)
        throw new Error(
          `${this.entrypoint} logged no ${String(pattern)} in ${String(limitMs)} ms: ${this.logs
            .slice(-20)
            .map(({ text }) => text)
            .join('\n')}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Sends a real signal and waits for the exit. Nothing restarts it afterwards. */
  public async stop(
    signal: NodeJS.Signals,
    limitMs = 120_000,
  ): Promise<ExitRecord | undefined> {
    this.restarting = false;
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child;
    if (child === undefined) return undefined;
    const exited = new Promise<ExitRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${this.entrypoint} ignored ${signal}`));
      }, limitMs);
      child.once('exit', (code, exitSignal) => {
        clearTimeout(timer);
        resolve({ at: Date.now(), code, signal: exitSignal });
      });
    });
    child.kill(signal);
    return exited;
  }

  /** Freezes or thaws the process, the way a stalled host or a long pause does. */
  public signal(signal: 'SIGCONT' | 'SIGSTOP'): void {
    this.child?.kill(signal);
  }

  /** Lines at `level` or above that contain every given text. */
  public linesMentioning(
    texts: readonly string[],
    level: 'error' | 'info' | 'warn',
  ): readonly string[] {
    const minimum = LEVEL_ORDER.indexOf(level);
    return this.logs
      .filter((line) => LEVEL_ORDER.indexOf(line.level) >= minimum)
      .filter((line) => texts.every((text) => line.text.includes(text)))
      .map((line) => line.text);
  }

  private spawnOnce(): void {
    const child = spawn(process.execPath, [this.entrypoint], {
      cwd: repositoryRoot,
      env: this.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.starts.push(Date.now());
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines)
          if (line.length > 0) this.logs.push(parseLine(line));
      });
    }
    child.once('exit', (code, signal) => {
      this.child = undefined;
      this.exits.push({ at: Date.now(), code, signal });
      if (this.restarting)
        this.restartTimer = setTimeout(() => {
          this.restartTimer = undefined;
          if (this.restarting) this.spawnOnce();
        }, RESTART_DELAY_MS);
    });
  }
}
