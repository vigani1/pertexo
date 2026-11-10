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
const directory = ${JSON.stringify(directory)};
if (args[0] === 'ps') {
  if (fs.existsSync(directory + '/container-args')) {
    const saved = JSON.parse(fs.readFileSync(directory + '/container-args', 'utf8'));
    const labels = saved.flatMap((arg, index) => arg === '--label' ? [saved[index + 1]] : []);
    const filters = args.flatMap((arg, index) => arg === '--filter' ? [args[index + 1].slice(6)] : []);
    const pid = Number(fs.readFileSync(saved[saved.indexOf('--cidfile') + 1], 'utf8'));
    try { process.kill(pid, 0); if (filters.every((value) => labels.includes(value))) console.log(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  process.exit(0);
}
if (args[0] === 'rm') {
  try { process.kill(Number(args.at(-1)), 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  process.exit(0);
}
fs.writeFileSync(args[args.indexOf('--cidfile') + 1], String(process.pid));
fs.appendFileSync(directory + '/container-starts', 'run\\n');
fs.writeFileSync(directory + '/container-args', JSON.stringify(args));
const worker = spawn('sh', ['-c', args[args.indexOf('-c') + 1], 'sh', directory, args.at(-1)], { stdio: 'inherit' });
process.on('SIGTERM', () => worker.kill('SIGTERM'));
worker.once('exit', (code) => process.exit(code ?? 143));
`,
    { mode: 0o755 },
  );
}

export const dockerHelperLifecycle = String.raw`
import atexit, signal
records=Path(os.environ['PERTEXO_BETA_ROOT'])/'fake-helpers'
records.mkdir(exist_ok=True)
if args[0]=='ps' and any('label=io.pertexo.backup.' in arg for arg in args):
 filters=[args[i+1][6:] for i,arg in enumerate(args) if arg=='--filter']
 for record in records.glob('*.json'):
  try:
   labels=json.loads(record.read_text())
   os.kill(int(record.stem),0)
   if all(value in labels for value in filters): print(record.stem)
  except (FileNotFoundError, ProcessLookupError): pass
 sys.exit(0)
if args[0]=='rm':
 for value in args[1:]:
  if value.isdigit() and (records/(value+'.json')).exists():
   try: os.kill(int(value),signal.SIGTERM)
   except ProcessLookupError: pass
 sys.exit(0)
labels=[args[i+1] for i,arg in enumerate(args) if arg=='--label']
if args[0]=='run' and 'io.pertexo.backup.helper=true' in labels:
 record=records/(str(os.getpid())+'.json')
 record.write_text(json.dumps(labels))
 atexit.register(lambda: record.unlink(missing_ok=True))
 signal.signal(signal.SIGTERM,lambda *unused: sys.exit(143))
 if '--cidfile' in args: Path(args[args.index('--cidfile')+1]).write_text(str(os.getpid()))
 if '--entrypoint' in args and args[args.index('--entrypoint')+1]=='sh':
  mounts=[args[i+1] for i,arg in enumerate(args) if arg=='-v']
  work=Path(next(value[:-8] for value in mounts if value.endswith(':/backup')))
  (work/'transport.ready').write_text(args[-1])
  while True: time.sleep(.05)
`;
