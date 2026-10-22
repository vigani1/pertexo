import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  DEFAULT_CODE_SETTINGS,
  CODE_PYTHON_MODULES,
} from '/workspace/packages/node-sdk/dist/index.js';
import { createCodeRunnerClient } from '/workspace/apps/worker/dist/attempts/code/client.js';

const python = '/opt/pertexo-python/bin/python3.15';
const launcher = '/workspace/apps/code-runner/dist/launch';
const client = createCodeRunnerClient({
  settings: DEFAULT_CODE_SETTINGS,
  socketPath: '/run/pertexo-code/runner.sock',
  requireHardened: true,
});
const source = `
import os, sys, subprocess, socket, ctypes, threading, resource, json
result = {}
def check(name, operation):
    try:
        operation()
        result[name] = "ALLOWED"
    except OSError as error:
        result[name] = error.errno
check("write", lambda: open("/tmp/python-escape", "w"))
check("fork", os.fork)
check("subprocess", lambda: subprocess.run(["/bin/true"], check=True))
check("socket", lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM))
check("unixSocket", lambda: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM))
check("manager", lambda: open("/proc/1/environ", "rb"))
check("protocol", lambda: os.listdir("/run/pertexo-code"))
libc = ctypes.CDLL(None, use_errno=True)
result["ctypesSocket"] = libc.socket(2, 1, 0)
result["ctypesErrno"] = ctypes.get_errno()
workers = []
stop = threading.Event()
for index in range(64):
    try:
        thread = threading.Thread(target=stop.wait, daemon=True)
        thread.start()
        workers.append(thread)
    except RuntimeError:
        break
result["threads"] = len(workers)
stop.set()
for thread in workers: thread.join()
result["status"] = open("/proc/self/status").read()
print(json.dumps(result))
`;

async function probe(code) {
  const process = spawn(
    launcher,
    ['20015', '32', '5', python, '-I', '-B', '-c', code],
    {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  process.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  process.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => {
    process.kill('SIGKILL');
  }, 8000);
  try {
    const code = await new Promise((resolve, reject) => {
      process.once('error', reject);
      process.once('close', resolve);
    });
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timeout);
  }
}

try {
  // No import policy or removed builtins: only the production launcher's
  // inherited kernel and identity fences stand between Python and the host.
  const [result, healthy] = await Promise.all([
    probe(source),
    client.execute(
      {
        language: 'python',
        code: 'return {"healthy": input}',
        timeoutSeconds: 3,
        input: 42,
        variables: {},
      },
      AbortSignal.timeout(10000),
    ),
  ]);
  assert.equal(healthy.kind, 'succeeded', JSON.stringify(healthy));
  assert.deepEqual(healthy.output, { healthy: 42 });
  for (const key of ['write', 'fork', 'subprocess', 'socket', 'unixSocket'])
    assert.equal(result[key], 38, key);
  for (const key of ['manager', 'protocol']) assert.equal(result[key], 13, key);
  assert.equal(result.ctypesSocket, -1);
  assert.equal(result.ctypesErrno, 38);
  assert(
    result.threads > 0 && result.threads <= 15,
    'per-UID task thread bound',
  );
  assert.match(result.status, /^Uid:\s*20015\s+20015\s+20015\s+20015$/mu);
  assert.match(result.status, /^CapEff:\s*0+$/mu);
  assert.match(result.status, /^NoNewPrivs:\s*1$/mu);
  assert.match(result.status, /^Seccomp:\s*2$/mu);
  console.log(
    'Python kernel fences refused writes, forks, subprocess, sockets and ctypes bypass; thread creation stayed bounded beside a healthy task.',
  );
  const headroom = await probe(`
import resource, importlib, json
resource.setrlimit(resource.RLIMIT_DATA, (32 * 1048576, 32 * 1048576))
for name in ${JSON.stringify(CODE_PYTHON_MODULES)}: importlib.import_module(name)
from zoneinfo import ZoneInfo
assert ZoneInfo("Europe/Paris").key == "Europe/Paris"
print(json.dumps({"dataLimitMiB": resource.getrlimit(resource.RLIMIT_DATA)[0] // 1048576, "maximumRssKiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}))
`);
  console.log(
    'Python minimum-memory module qualification:',
    JSON.stringify(headroom),
  );
} finally {
  client.close();
}
