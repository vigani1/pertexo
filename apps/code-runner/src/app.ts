import { assertRunnerIsolation, type RunnerConfig } from './config.js';
import { createTaskProcessPool } from './process/pool.js';
import { listenForCodeTasks } from './transport/server.js';

/** A manager handles data and process lifetime; it never evaluates user code. */
export async function startCodeRunner(config: RunnerConfig) {
  await assertRunnerIsolation(config);
  const pool = await createTaskProcessPool(config);
  try {
    return await listenForCodeTasks(config, pool);
  } catch (error: unknown) {
    await pool.close();
    throw error;
  }
}
