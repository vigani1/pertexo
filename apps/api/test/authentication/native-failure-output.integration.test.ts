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

function resetInProcess(
  databaseUrl: string,
  email: string,
  extra: Readonly<{
    mode?: 'session_lookup' | 'sign_up';
    cookie?: string;
  }> = {},
) {
  const child = fork(
    fileURLToPath(
      new URL(
        extra.mode === undefined
          ? './native-failure-process.fixture.ts'
          : './session-failure-process.fixture.ts',
        import.meta.url,
      ),
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
    child.send({ databaseUrl, redisUrl, email, ...extra });
  });
}

describe.runIf(betterAuthIntegrationEnabled)(
  'native authentication process diagnostics',
  () => {
    let databaseUrl = '';
    const api = useBetterAuthRealApi('native_output', {
      afterMigration: (url) => {
        databaseUrl = url(apiBaseUrl);
        return Promise.resolve();
      },
    });

    it.each(['session_lookup', 'sign_up'] as const)(
      'keeps %s storage failures out of process output and retains request correlation',
      async (mode) => {
        const email = `private-${mode}@example.test`;
        let cookie: string | undefined;
        if (mode === 'session_lookup') {
          await api.signUp(email, '/login?verified=true');
          cookie = (await api.signIn(email)).cookie;
          const healthy = await resetInProcess(databaseUrl, email, {
            mode,
            cookie,
          });
          expect(healthy.code).toBe(0);
          expect(healthy.response).toMatchObject({ status: 200 });
          await api.database()
            .query(`create function public.reject_native_user(value text) returns boolean language plpgsql as $$ begin raise exception 'private-session-database: %', value; end $$;
          alter table app.users enable row level security;
          create policy reject_native_user on app.users for select to pertexo_app using(public.reject_native_user(email))`);
        } else {
          await api.database()
            .query(`create function public.reject_native_user_insert() returns trigger language plpgsql as $$ begin raise exception 'private-user-database: %', new.email; end $$;
          create trigger reject_native_user_insert before insert on app.users for each row execute function public.reject_native_user_insert()`);
        }
        let result: Awaited<ReturnType<typeof resetInProcess>>;
        try {
          result = await resetInProcess(databaseUrl, email, {
            mode,
            ...(cookie === undefined ? {} : { cookie }),
          });
        } finally {
          if (mode === 'session_lookup')
            await api
              .database()
              .query(
                'drop policy reject_native_user on app.users; alter table app.users disable row level security; drop function public.reject_native_user(text)',
              );
          else
            await api
              .database()
              .query(
                'drop trigger reject_native_user_insert on app.users; drop function public.reject_native_user_insert()',
              );
        }
        expect(result.code).toBe(0);
        expect(result.response).toMatchObject({
          status: mode === 'session_lookup' ? 500 : 400,
          body: {
            code:
              mode === 'session_lookup'
                ? 'internal.unexpected'
                : 'request.invalid',
            requestId: expect.any(String) as unknown,
          },
          requestId: expect.any(String) as unknown,
        });
        const requestId = (result.response as { requestId: string }).requestId;
        for (const text of [
          result.stdout,
          result.stderr,
          JSON.stringify(result.response),
        ])
          for (const privateValue of [
            email,
            'private-session-database',
            'private-user-database',
            'DrizzleQueryError',
            'params:',
            'select *',
            'insert into',
          ])
            expect(text).not.toContain(privateValue);
        const records = (result.stdout + result.stderr)
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(
          records.some(
            (record) => record.requestId === requestId && record.level === 50,
          ),
        ).toBe(true);
        if (mode === 'sign_up')
          expect(
            records.filter(
              (record) => record.event === 'authentication.failed',
            ),
          ).toMatchObject([
            { flow: 'sign_up', reason: 'internal_failure', requestId },
          ]);
      },
      30000,
    );

    it('keeps storage parameters and reset proofs out of stdout, stderr and HTTP, with one correlated safe diagnostic', async () => {
      const email = 'private-reset-owner@example.test';
      await api.signUp(email, '/login?verified=true');
      await api.database()
        .query(`create function public.reject_native_proof() returns trigger language plpgsql as $$ begin raise exception 'private-storage-error: %', new.identifier; end $$;
      create trigger reject_native_proof before insert on app.auth_verifications for each row execute function public.reject_native_proof()`);
      let result: Awaited<ReturnType<typeof resetInProcess>>;
      let absent: Awaited<ReturnType<typeof resetInProcess>>;
      try {
        result = await resetInProcess(databaseUrl, email);
        absent = await resetInProcess(databaseUrl, 'absent-reset@example.test');
      } finally {
        await api
          .database()
          .query(
            'drop trigger reject_native_proof on app.auth_verifications; drop function public.reject_native_proof()',
          );
      }
      expect(result.code).toBe(0);
      expect(result.response).toMatchObject({
        status: 200,
        body: {
          status: true,
          message:
            'If this email exists in our system, check your email for the reset link',
        },
      });
      expect(absent.code).toBe(0);
      expect(absent.response).toMatchObject({
        status: 200,
        body: (result.response as { body: unknown }).body,
      });
      expect(absent.stdout + absent.stderr).toBe('');
      for (const text of [
        absent.stdout,
        absent.stderr,
        JSON.stringify(absent.response),
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
        time: expect.any(Number) as unknown,
        environment: 'test',
        serviceName: 'api',
        serviceVersion: 'test',
        msg: 'authentication.failed',
        event: 'authentication.failed',
        flow: 'password_reset',
        reason: 'internal_failure',
        requestId: expect.any(String) as unknown,
      });
      expect(result.response).toMatchObject({
        requestId: records[0]?.requestId,
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
