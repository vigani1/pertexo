// The worker's progress marker has one fixed path, which every worker on this host
// writes to. This gives one worker a file of its own, so a test reads that worker.
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const FIXED_PATH = '/tmp/pertexo-worker-progress';
const ownPath = process.env.PROGRESS_MARKER_STAND_IN;
const { writeFile } = fsPromises;

fsPromises.writeFile = (path, ...rest) =>
  writeFile(path === FIXED_PATH ? ownPath : path, ...rest);
syncBuiltinESMExports();
