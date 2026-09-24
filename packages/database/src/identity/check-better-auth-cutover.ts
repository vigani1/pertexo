import { Pool } from 'pg';
import { parseMigrationConfig } from '../config.js';

import {
  assertBetterAuthCutoverReady,
  inspectBetterAuthCutover,
} from './better-auth-cutover-preflight.js';

const config = parseMigrationConfig();
const pool = new Pool({ connectionString: config.connectionString, max: 1 });
try {
  const client = await pool.connect();
  try {
    await client.query(`set role "${config.ownerRole.replaceAll('"', '""')}"`);
    const result = await inspectBetterAuthCutover(client);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    assertBetterAuthCutoverReady(result);
  } finally {
    await client.query('reset role').catch(() => undefined);
    client.release();
  }
} finally {
  await pool.end();
}
