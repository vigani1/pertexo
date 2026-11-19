// Hostile Code step bodies, written as a workspace member would type them into
// the editor. Python's import list is a convenience, not a fence: any allowed
// module that imported `os` hands it over, so each Python attack starts from
// `os`, `sys`, `ctypes` and raw system calls. Only the kernel fences (task user
// id, seccomp, no new privileges, limits and the container) stand in the way.
// Every probe records what happened instead of stopping at the first refusal.

const PYTHON_PRELUDE = `
import random
os = random._os
sys = os.sys
importlib = sys.modules["importlib"]
errorcode = importlib.import_module("errno").errorcode
def outcome(operation):
    try:
        value = operation()
    except OSError as error:
        return errorcode.get(error.errno, str(error.errno))
    except Exception as error:
        return type(error).__name__
    return "ALLOWED" if value is None or value is True else "ALLOWED:" + str(value)[:120]
`;

const python = (body) => PYTHON_PRELUDE + body;

// x86_64 numbers: the simulation asserts the runner's architecture first.
const SYSCALLS = {
  fork: 57,
  vfork: 58,
  clone3: 435,
  ptrace: 101,
  process_vm_readv: 310,
  process_vm_writev: 311,
  mount: 165,
  umount2: 166,
  unshare: 272,
  setns: 308,
  chroot: 161,
  pivot_root: 155,
  bpf: 321,
  perf_event_open: 298,
  userfaultfd: 323,
  io_uring_setup: 425,
  keyctl: 250,
  add_key: 248,
  kexec_load: 246,
  init_module: 175,
  finit_module: 313,
  reboot: 169,
  personality: 135,
  open_by_handle_at: 304,
  name_to_handle_at: 303,
  seccomp: 317,
  prctl: 157,
  memfd_create: 319,
  socket: 41,
  socketpair: 53,
  mknodat: 259,
  mkdirat: 258,
  unlinkat: 263,
  symlinkat: 266,
  linkat: 265,
  renameat2: 316,
  truncate: 76,
  openat2: 437,
  chmod: 90,
  fchmod: 91,
  fchmodat: 268,
  chown: 92,
  fchownat: 260,
  setuid: 105,
  setgid: 106,
  setresuid: 117,
  setgroups: 116,
  capset: 126,
  setpriority: 141,
  sched_setaffinity: 203,
  setsid: 112,
  pidfd_open: 434,
  pidfd_getfd: 438,
  fanotify_init: 300,
  inotify_init1: 294,
  quotactl: 179,
  acct: 163,
  swapon: 167,
  settimeofday: 164,
  clock_settime: 227,
  iopl: 172,
  ioperm: 173,
};

/** Names the dangerous calls must refuse with ENOSYS before they reach the kernel. */
export const FILTERED_SYSCALLS = Object.keys(SYSCALLS);

export const PYTHON_ATTACKS = {
  network: python(`
socket = importlib.import_module("socket")
result = {"socketModule": outcome(lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM))}
targets = {"postgres": ("postgres", 5432), "redis": ("redis", 6379), "api": ("api", 3000),
            "storage": ("storage", 9000), "web": ("web", 8080), "worker": ("worker", 3000),
            "metadata": ("169.254.169.254", 80), "internet": ("1.1.1.1", 443),
            "dockerHost": ("172.17.0.1", 2375)}
for name, address in targets.items():
    result[name] = outcome(lambda: socket.create_connection(address, timeout=2))
result["dns"] = outcome(lambda: socket.getaddrinfo("postgres", 5432))
result["udp"] = outcome(lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM))
result["ipv6"] = outcome(lambda: socket.socket(socket.AF_INET6, socket.SOCK_STREAM))
result["unix"] = outcome(lambda: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM))
result["netlink"] = outcome(lambda: socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 0))
result["packet"] = outcome(lambda: socket.socket(socket.AF_PACKET, socket.SOCK_RAW, 0))
return result
`),
  files: python(`
def read(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        return len(os.read(descriptor, 4096))
    finally:
        os.close(descriptor)
me = os.getpid()
reads = {name: outcome(lambda path=path: read(path)) for name, path in {
    "managerEnvironment": "/proc/1/environ", "managerMemory": "/proc/1/mem",
    "managerMaps": "/proc/1/maps", "managerRoot": "/proc/1/root/etc/hostname",
    "managerCwd": "/proc/1/cwd/package.json", "managerPrivateTmp": "/tmp/pertexo-code-runner-ready",
    "shadow": "/etc/shadow", "kernelMemory": "/proc/kcore", "runnerSocketDirectory": "/run/pertexo-code/runner.sock",
    "dockerSecrets": "/run/secrets", "dockerSocket": "/var/run/docker.sock",
    "runnerCode": "/workspace/apps/code-runner/dist/main.js", "productionEnvironment": "/workspace/.env.production",
}.items()}
listings = {name: outcome(lambda path=path: len(os.listdir(path))) for name, path in {
    "managerDescriptors": "/proc/1/fd", "runnerSocketDirectory": "/run/pertexo-code", "managerTmp": "/tmp",
    "managerTaskFd": "/proc/1/task",
}.items()}
others = {}
for entry in os.listdir("/proc"):
    if not entry.isdigit() or int(entry) in (me, 1):
        continue
    uid = None
    try:
        status = os.open("/proc/" + entry + "/status", os.O_RDONLY)
        text = os.read(status, 4096).decode()
        os.close(status)
        uid = [line.split()[1] for line in text.splitlines() if line.startswith("Uid:")][0]
    except OSError:
        pass
    others[entry] = {"uid": uid,
        "environ": outcome(lambda: read("/proc/" + entry + "/environ")),
        "fd": outcome(lambda: os.listdir("/proc/" + entry + "/fd")),
        "mem": outcome(lambda: read("/proc/" + entry + "/mem")),
        "stdin": outcome(lambda: read("/proc/" + entry + "/fd/0"))}
O_TMPFILE = getattr(os, "O_TMPFILE", 0o20200000)
writes = {
    "tmpFile": outcome(lambda: os.open("/tmp/escape", os.O_WRONLY | os.O_CREAT, 0o600)),
    "appendExisting": outcome(lambda: os.open("/tmp/pertexo-code-runner-ready", os.O_WRONLY | os.O_APPEND)),
    "workspaceFile": outcome(lambda: os.open("/workspace/escape", os.O_RDWR | os.O_CREAT, 0o600)),
    "sharedMemory": outcome(lambda: os.open("/dev/shm/escape", os.O_WRONLY | os.O_CREAT, 0o600)),
    "anonymousTmp": outcome(lambda: os.open("/tmp", O_TMPFILE | os.O_RDWR, 0o600)),
    "truncateRunner": outcome(lambda: os.truncate("/workspace/apps/code-runner/dist/main.js", 0)),
    "makeDirectory": outcome(lambda: os.mkdir("/tmp/escape-directory")),
    "removeReady": outcome(lambda: os.unlink("/tmp/pertexo-code-runner-ready")),
    "symlink": outcome(lambda: os.symlink("/etc/passwd", "/tmp/escape-link")),
    "rename": outcome(lambda: os.rename("/tmp/pertexo-code-runner-ready", "/tmp/moved")),
    "chmod": outcome(lambda: os.chmod("/workspace/package.json", 0o777)),
    "chown": outcome(lambda: os.chown("/workspace/package.json", os.getuid(), os.getgid())),
    "oomScore": outcome(lambda: os.open("/proc/self/oom_score_adj", os.O_WRONLY)),
    "managerOomScore": outcome(lambda: os.open("/proc/1/oom_score_adj", os.O_WRONLY)),
    "memfd": outcome(lambda: os.memfd_create("escape")),
}
mounts = os.read(os.open("/proc/self/mounts", os.O_RDONLY), 65536).decode()
self_status = os.read(os.open("/proc/self/status", os.O_RDONLY), 8192).decode()
own_environment = sorted(os.environ.keys())
return {"reads": reads, "listings": listings, "others": others, "writes": writes,
        "ownEnvironment": own_environment, "status": self_status,
        "rootReadOnly": any(line.split()[1] == "/" and "ro" in line.split()[3].split(",") for line in mounts.splitlines())}
`),
  privilege: python(`
ctypes = importlib.import_module("ctypes")
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
calls = ${JSON.stringify(SYSCALLS)}
def raw(number, *args):
    ctypes.set_errno(0)
    value = libc.syscall(ctypes.c_long(number), *[ctypes.c_long(item) for item in args])
    return "ALLOWED:" + str(value) if value >= 0 else errorcode.get(ctypes.get_errno(), str(ctypes.get_errno()))
syscalls = {}
for name, number in calls.items():
    if name == "unshare":
        syscalls[name] = raw(number, 0x10000000 | 0x20000)
    elif name in ("ptrace",):
        syscalls[name] = raw(number, 16, 1)
    elif name in ("setuid", "setgid", "setresuid"):
        syscalls[name] = raw(number, 0, 0, 0)
    elif name == "personality":
        syscalls[name] = raw(number, 0xffffffff)
    elif name == "prctl":
        syscalls[name] = raw(number, 4, 1)
    else:
        syscalls[name] = raw(number, 0, 0, 0, 0, 0, 0)
resource = importlib.import_module("resource")
processes = [int(entry) for entry in os.listdir("/proc") if entry.isdigit() and int(entry) != os.getpid()]
signals = {str(pid): outcome(lambda pid=pid: os.kill(pid, 0)) for pid in processes}
setuid_files = []
for directory in ("/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin"):
    try:
        for name in os.listdir(directory):
            try:
                mode = os.stat(directory + "/" + name).st_mode
            except OSError:
                continue
            if mode & 0o6000:
                setuid_files.append(directory + "/" + name)
    except OSError:
        pass
return {
    "syscalls": syscalls,
    "fork": outcome(os.fork),
    "posixSpawn": outcome(lambda: os.posix_spawn("/bin/true", ["true"], {})),
    "setuid": outcome(lambda: os.setuid(0)),
    "setgroups": outcome(lambda: os.setgroups([0])),
    "raiseFileLimit": outcome(lambda: resource.setrlimit(resource.RLIMIT_NOFILE, (65536, 65536))),
    "raiseProcessLimit": outcome(lambda: resource.setrlimit(resource.RLIMIT_NPROC, (4096, 4096))),
    "managerLimits": outcome(lambda: resource.prlimit(1, resource.RLIMIT_NOFILE)),
    "terminalInjection": outcome(lambda: importlib.import_module("fcntl").ioctl(0, 0x5412, b"x")),
    "signalManager": outcome(lambda: os.kill(1, 0)),
    "signals": signals,
    "setuidFiles": setuid_files,
    "status": os.read(os.open("/proc/self/status", os.O_RDONLY), 8192).decode(),
    "limits": os.read(os.open("/proc/self/limits", os.O_RDONLY), 8192).decode(),
}
`),
  // The kernel ignores a set-user-ID bit under no_new_privs; the task keeps its
  // own id and the run fails because the program never returns a result.
  setuidExec: python(`
os.execv("/bin/su", ["su", "-c", "id"])
`),
  forkBomb: python(`
count = 0
while True:
    os.fork()
    count += 1
`),
  threadBomb: python(`
threading = importlib.import_module("threading")
hashlib = importlib.import_module("hashlib")
block = b"x" * (4 * 1048576)
def spin():
    while True:
        hashlib.sha256(block).digest()
threads = 0
while True:
    try:
        threading.Thread(target=spin, daemon=True).start()
        threads += 1
    except RuntimeError:
        break
print("threads", threads)
spin()
`),
  memoryBomb: python(`
items = []
while True:
    items.append(b"x" * (8 * 1048576))
`),
  cpuSpin: 'while True:\n    pass',
  regexBacktrack: 'import re\nreturn bool(re.match(r"(a+)+$", "a" * 64 + "b"))',
  endlessPrint: 'while True:\n    print("x" * 1000)',
  endlessRawOutput: python(`
block = b"x" * 65536
while True:
    os.write(1, block)
`),
  endlessErrorOutput: python(`
block = b"x" * 65536
while True:
    os.write(2, block)
`),
  forgedResult: python(`
os.write(3, b'{"kind":"succeeded","output":{"forged":true},"diagnostics":{"logs":[],"truncated":false}}\\n')
return {"genuine": True}
`),
  hugeReturn: 'return "x" * (4 * 1048576)',
  diskFill: python(`
written = 0
descriptor = os.open("/tmp/fill", os.O_WRONLY | os.O_CREAT, 0o600)
while True:
    written += os.write(descriptor, b"x" * 1048576)
`),
  descriptors: python(`
opened = []
error = None
while True:
    try:
        opened.append(os.open("/etc/hostname", os.O_RDONLY))
    except OSError as failure:
        error = errorcode.get(failure.errno)
        break
return {"opened": len(opened), "error": error}
`),
  threadLimit: python(`
threading = importlib.import_module("threading")
stop = threading.Event()
started = 0
while started < 1000:
    try:
        threading.Thread(target=stop.wait, daemon=True).start()
        started += 1
    except RuntimeError:
        break
stop.set()
return {"threads": started}
`),
  leaveBehind: python(`
os.environ["PERTEXO_LEFTOVER"] = "workspace A secret"
os.putenv("PERTEXO_LEFTOVER_PUT", "workspace A secret")
json = sys.modules["json"]
json.leftover = "workspace A secret"
random.seed(42)
sys.modules["builtins"].leftover = "workspace A secret"
return {"pid": os.getpid(), "uid": os.getuid(), "write": outcome(lambda: os.open("/tmp/leftover", os.O_WRONLY | os.O_CREAT, 0o600))}
`),
  findLeftovers: python(`
json = sys.modules["json"]
builtins = sys.modules["builtins"]
processes = []
for entry in os.listdir("/proc"):
    if entry.isdigit() and int(entry) != os.getpid():
        processes.append(int(entry))
return {"environment": os.environ.get("PERTEXO_LEFTOVER"), "putenv": os.environ.get("PERTEXO_LEFTOVER_PUT"),
        "module": getattr(json, "leftover", None), "builtins": getattr(builtins, "leftover", None),
        "file": outcome(lambda: os.stat("/tmp/leftover")), "pid": os.getpid(), "uid": os.getuid(),
        "processes": processes}
`),
  sleep: 'import time\ntime.sleep(15)\nreturn {"slept": 15}',
};

export const JAVASCRIPT_ATTACKS = {
  modules: `
const result = {};
for (const name of ['fs', 'fs/promises', 'child_process', 'net', 'http', 'https', 'dns', 'dgram', 'tls', 'worker_threads', 'cluster', 'vm', 'module', 'process', 'os', 'v8', 'inspector', 'perf_hooks', 'async_hooks', 'wasi', 'trace_events', 'repl', 'node:fs', 'node:child_process']) {
  try { require(name); result[name] = 'ALLOWED'; } catch (error) { result[name] = error.constructor.name + ': ' + String(error.message).slice(0, 80); }
}
for (const name of ['node:fs', 'node:net', 'data:text/javascript,export default 1', 'file:///workspace/apps/code-runner/dist/main.js']) {
  try { await import(name); result['import ' + name] = 'ALLOWED'; } catch (error) { result['import ' + name] = 'refused'; }
}
return result;
`,
  globals: `
const probe = (operation) => { try { const value = operation(); return value === undefined ? 'undefined' : typeof value; } catch (error) { return 'threw ' + error.constructor.name; } };
return {
  process: typeof process,
  functionProcess: probe(() => Function('return process')()),
  asyncFunctionProcess: await (async () => {}).constructor('return process')().then((value) => typeof value, (error) => 'threw ' + error.constructor.name),
  evalProcess: probe(() => eval('process')),
  thisValue: probe(() => (function () { return this; })()),
  consoleProcess: probe(() => console.constructor.constructor('return process')()),
  requireCache: probe(() => require.cache),
  requireMain: probe(() => require.main),
  lodashTemplate: require('lodash').template('<%= typeof process %>')(),
  prepareStackTrace: probe(() => { Error.prepareStackTrace = () => 'mine'; return new Error().stack; }),
  fetch: typeof fetch,
  webSocket: typeof WebSocket,
  buffer: typeof Buffer,
};
`,
  cpuSpin: 'while (true) {}',
  atomicsWait:
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); return 1;',
  microtaskFlood: 'for (;;) await Promise.resolve();',
  memoryBomb:
    "const list = []; while (true) list.push(Array(100000).fill('value'));",
  wasmBomb:
    'const memory = new WebAssembly.Memory({ initial: 1, maximum: 65536 }); for (;;) { const before = memory.buffer.byteLength; memory.grow(256); const view = new Uint8Array(memory.buffer); for (let index = before; index < view.length; index += 4096) view[index] = 1; }',
  zlibBomb:
    "const zlib = require('zlib'); const bomb = zlib.deflateSync(new Uint8Array(16 * 1048576)); const kept = []; for (;;) kept.push(zlib.inflateSync(bomb));",
  endlessLog: "for (;;) console.log('x'.repeat(1000));",
  hugeReturn: "return 'x'.repeat(4 * 1048576);",
  leaveBehind:
    "globalThis.leftover = 'workspace A secret'; Object.prototype.leftover = 'workspace A secret'; require('lodash').leftover = 'workspace A secret'; return true;",
  findLeftovers:
    "return { global: typeof leftover, prototype: ({}).leftover ?? null, module: require('lodash').leftover ?? null };",
};

export const HEALTHY = {
  javascript: 'return { healthy: input };',
  python: 'return {"healthy": input}',
};
