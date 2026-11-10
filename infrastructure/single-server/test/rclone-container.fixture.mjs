import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Docker is the outside service: run its mounted worker with a fixture rclone CLI.
export async function writeContainerAdapter(directory) {
  await writeFile(
    join(directory, 'bin/docker'),
    `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'rm') {
  try { process.kill(Number(args.at(-1)), 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  process.exit(0);
}
const directory = ${JSON.stringify(directory)};
fs.writeFileSync(args[args.indexOf('--cidfile') + 1], String(process.pid));
fs.appendFileSync(directory + '/container-starts', 'run\\n');
fs.writeFileSync(directory + '/container-args', JSON.stringify(args));
const worker = spawn('sh', ['-c', args[args.indexOf('-c') + 1], 'sh', directory], { stdio: 'inherit' });
process.on('SIGTERM', () => worker.kill('SIGTERM'));
worker.once('exit', (code) => process.exit(code ?? 143));
`,
    { mode: 0o755 },
  );
}
