import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const hostPath = fileURLToPath(new URL('./host.fixture.mjs', import.meta.url));
const HOST_DEADLINE_MS = 120_000;

const reportSchema = z.union([
  z.object({ started: z.string() }).strict(),
  z
    .object({
      expression: z.string(),
      elapsedMs: z.number(),
      result: z
        .object({
          kind: z.enum(['value', 'missing', 'error']),
          code: z.string().optional(),
          limit: z.string().optional(),
          message: z.string().optional(),
          value: z.json().optional(),
        })
        .strict(),
    })
    .strict(),
]);

export type HostRequest = Readonly<{
  expression: string;
  runInput?: z.core.util.JSONType;
}>;

export type HostedEvaluation = Exclude<
  z.output<typeof reportSchema>,
  { started: string }
>;

export type HostOutcome = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  evaluations: readonly HostedEvaluation[];
  /** The expression the process was on when it stopped, if it did not finish. */
  unfinished: readonly string[];
  crashOutput: string;
}>;

/** Evaluates expressions in a real, separate Node process and watches it live or die. */
export function evaluateInRealProcess(
  requests: readonly HostRequest[],
  { concurrently = false }: Readonly<{ concurrently?: boolean }> = {},
): Promise<HostOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hostPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => {
      // V8 prints a long native stack; the first lines say what happened.
      if (stderr.length < 4_096) stderr += chunk;
    });
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
    }, HOST_DEADLINE_MS);
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(deadline);
      const reports = stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => reportSchema.parse(JSON.parse(line)));
      const evaluations = reports.filter(
        (report): report is HostedEvaluation => 'expression' in report,
      );
      const finished = new Set(evaluations.map((item) => item.expression));
      resolve({
        exitCode,
        signal,
        evaluations,
        unfinished: reports.flatMap((report) =>
          'started' in report && !finished.has(report.started)
            ? [report.started]
            : [],
        ),
        crashOutput: stderr.slice(0, 600),
      });
    });
    child.stdin.end(JSON.stringify({ requests, concurrently }));
  });
}
