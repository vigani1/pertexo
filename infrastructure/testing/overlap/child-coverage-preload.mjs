import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

// Loaded into the Vitest processes of one measured test file (through
// NODE_OPTIONS). Every process a test starts gets NODE_V8_COVERAGE, so Node
// writes that child's V8 coverage into the file's own directory when it
// exits. Children usually inherit it, but many tests start the API or worker
// with an environment built from scratch, so the variable is added to an
// explicit `env` too. Only Vitest's workers (the processes running the test
// file) and their descendants do this; Vitest's main process starts the
// workers, whose coverage Vitest itself measures.

export const CHILD_COVERAGE_VARIABLE = 'PERTEXO_OVERLAP_CHILD_COVERAGE';

const directory = process.env[CHILD_COVERAGE_VARIABLE];

// Where each function takes its options object: after the command (exec*) or
// after the optional argument list (spawn*, execFile*, fork).
const OPTIONS_AFTER_COMMAND = new Set(['exec', 'execSync']);
const PATCHED = [
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'fork',
  'exec',
  'execSync',
];

if (directory !== undefined) {
  for (const name of PATCHED) {
    const original = childProcess[name];
    const withChildCoverage = function (...args) {
      return original.apply(this, coveredArguments(name, args));
    };
    // exec and execFile resolve { stdout, stderr } through their own promise
    // form; without it promisify would resolve the stdout string alone.
    const promised = original[promisify.custom];
    if (promised !== undefined)
      withChildCoverage[promisify.custom] = (...args) =>
        promised(...coveredArguments(name, args));
    childProcess[name] = withChildCoverage;
  }
  syncBuiltinESMExports();
}

function coveredArguments(name, args) {
  if (process.env.VITEST_WORKER_ID === undefined) return args;
  const result = [...args];
  let index = 1;
  if (
    !OPTIONS_AFTER_COMMAND.has(name) &&
    (Array.isArray(result[1]) || (result[1] == null && result.length > 2))
  )
    index = 2;
  const given = result[index];
  const isOptions =
    given !== null && typeof given === 'object' && !Array.isArray(given);
  const options = isOptions ? given : {};
  const env = { ...(options.env ?? process.env), NODE_V8_COVERAGE: directory };
  if (isOptions) result[index] = { ...options, env };
  else if (given === undefined && index >= result.length)
    result[index] = { env };
  else result.splice(index, 0, { env });
  return result;
}
