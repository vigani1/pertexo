import { canonicalizeBoundedJson } from '@pertexo/node-sdk/server';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import pg from 'pg';
import type { PostgresClient } from '@pertexo/contracts';
import { NodeDnsResolver } from '../outbound-http/transport/node.js';
import type { SecureHttpResolver } from '../outbound-http/secure-http.types.js';
import {
  assertPublicAddress,
  isAllowedPrivateAddress,
  type AllowedPrivateNetwork,
} from '../outbound-http/transport/address-policy.js';
import { PostgresError, postgresFailure } from './postgres.errors.js';
import {
  requirePostgresColumns,
  createPostgresResultReader,
} from './query.repository.js';

export function createSecurePostgresClient(
  networks: readonly AllowedPrivateNetwork[] = [],
  resolver: SecureHttpResolver = new NodeDnsResolver(),
): PostgresClient {
  return {
    async execute(credential, options, run) {
      let client: pg.Client | undefined;
      let stage: 'connect' | 'query' | 'commit' | 'fence' = 'connect';
      const deadline = AbortSignal.timeout(options.timeoutMillis);
      const signal =
        options.signal === undefined
          ? deadline
          : AbortSignal.any([deadline, options.signal]);
      const aborted = () =>
        new PostgresError(deadline.aborted ? 'timeout' : 'canceled');
      let onAbort: (() => void) | undefined;
      const interruption = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(aborted());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      try {
        const answers = await Promise.race([
          interruption,
          resolver.resolve(credential.host),
        ]);
        const target = answers[0];
        if (target === undefined) throw new PostgresError('connection_failed');
        for (const { address } of answers)
          checkAddress(address, credential.tls === 'disable', networks);
        // Fence credential use before any connection can send a password.
        stage = 'fence';
        await options.beforeDispatch();
        stage = 'connect';
        if (signal.aborted) throw aborted();
        const ssl =
          credential.tls === 'disable'
            ? false
            : {
                ...(isIP(credential.host) === 0
                  ? { servername: credential.host }
                  : {}),
                minVersion: 'TLSv1.2' as const,
                rejectUnauthorized: credential.tls === 'verify-full',
                ...(credential.ca === undefined ? {} : { ca: credential.ca }),
                checkServerIdentity: (
                  _host: string,
                  certificate: Parameters<typeof checkServerIdentity>[1],
                ) => checkServerIdentity(credential.host, certificate),
              };
        // The numeric host pins the socket. TLS verifies the original name.
        client = new pg.Client({
          host: target.address,
          port: credential.port,
          user: credential.user,
          database: credential.database,
          password: credential.password,
          ssl,
          connectionTimeoutMillis: options.timeoutMillis,
          statement_timeout: options.timeoutMillis,
        });
        const connection = client;
        // pg emits a separate event for errors outside an active query.
        connection.on('error', () => undefined);
        await Promise.race([interruption, connection.connect()]);
        stage = 'query';
        await Promise.race([
          interruption,
          connection.query(credential.readOnly ? 'BEGIN READ ONLY' : 'BEGIN'),
        ]);
        const sensitive = [credential.password];
        const result = await Promise.race([
          interruption,
          run({
            requireColumns: (schema, table, columns) =>
              requirePostgresColumns(connection, schema, table, columns),
            query: createPostgresResultReader(
              connection,
              options.maxRows,
              sensitive,
            ),
          }),
        ]);
        try {
          canonicalizeBoundedJson({
            items: result.rows,
            rowCount: result.rowCount,
          });
        } catch {
          throw new PostgresError('result_limit');
        }
        stage = 'commit';
        await Promise.race([interruption, connection.query('COMMIT')]);
        return { kind: 'succeeded', result };
      } catch (error) {
        if (stage === 'fence') throw error;
        return postgresFailure(error, stage);
      } finally {
        if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
        if (client !== undefined) {
          const closed = client.end();
          // The destination controls whether it sends its own FIN.
          client.connection.stream.destroy();
          await closed.catch(() => undefined);
        }
      }
    },
  };
}

function checkAddress(
  address: string,
  plaintext: boolean,
  networks: readonly AllowedPrivateNetwork[],
): void {
  try {
    assertPublicAddress(address);
  } catch {
    if (isAllowedPrivateAddress(address, networks)) return;
    throw new PostgresError('address_blocked');
  }
  if (plaintext) throw new PostgresError('tls_failed');
}
