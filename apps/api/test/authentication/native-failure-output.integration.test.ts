import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';
import {
  apiBaseUrl,
  redisUrl,
} from '../support/better-auth/api/environment.js';

function resetInProcess(databaseUrl: string, email: string) {
  const child = fork(
    fileURLToPath(
      new URL('./native-failure-process.fixture.ts', import.meta.url),
    ),
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let stdout = '';
  let stderr = '';
  let response: unknown;
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('message', (message: unknown) => {
    response = message;
  });
  return new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    response: unknown;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Native failure process did not close'));
    }, 15_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, response });
    });
    child.send({ databaseUrl, redisUrl, email });
  });
}

describe.runIf(betterAuthIntegrationEnabled)(
  'native authentication process diagnostics',
  () => {
    let databaseUrl = '';
    const api = useBetterAuthRealApi('native_output', {
      afterMigration: async (url) => {
        databaseUrl = url(apiBaseUrl);
      },
    });

    it('keeps storage parameters and reset proofs out of stdout, stderr and HTTP, with one correlated safe diagnostic', async () => {
      const email = 'private-reset-owner@example.test';
      await api.signUp(email, '/login?verified=true');
      await api.database()
        .query(`create function public.reject_native_proof() returns trigger language plpgsql as $$ begin raise exception 'private-storage-error: %', new.identifier; end $$;
      create trigger reject_native_proof before insert on app.auth_verifications for each row execute function public.reject_native_proof()`);
      let result: Awaited<ReturnType<typeof resetInProcess>>;
      try {
        result = await resetInProcess(databaseUrl, email);
      } finally {
        await api
          .database()
          .query(
            'drop trigger reject_native_proof on app.auth_verifications; drop function public.reject_native_proof()',
          );
      }
      expect(result.code).toBe(0);
      expect(result.response).toMatchObject({
        status: 500,
        body: { status: 500, code: 'internal.unexpected' },
      });
      for (const text of [
        result.stdout,
        result.stderr,
        JSON.stringify(result.response),
      ]) {
        for (const privateValue of [
          'reset-password:',
          'private-storage-error',
          email,
          'DrizzleQueryError',
          'insert into',
          'params:',
        ]) {
          expect(
            text.includes(privateValue),
            `private output: ${privateValue}`,
          ).toBe(false);
        }
      }
      const records = (result.stdout + result.stderr)
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual({
        level: 50,
        time: expect.any(Number),
        environment: 'test',
        serviceName: 'api',
        serviceVersion: 'test',
        msg: 'authentication.failed',
        event: 'authentication.failed',
        flow: 'password_reset',
        reason: 'internal_failure',
        requestId: expect.any(String),
      });
      expect(result.response).toMatchObject({
        requestId: records[0]?.requestId,
        body: { requestId: records[0]?.requestId },
      });
      expect(
        (
          await api
            .database()
            .query(
              "select id from app.auth_verifications where identifier like 'reset-password:%'",
            )
        ).rows,
      ).toEqual([]);
    });
  },
);
