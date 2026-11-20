import { readFile } from 'node:fs/promises';
import { must, mustDocker } from '../support/process.mjs';

// A Node service's own view of its memory (RSS, V8 heap, external and array
// buffers), read from outside without changing the product: the runner opens
// the process's inspector with SIGUSR1, then asks it for process.memoryUsage()
// from inside the container's network namespace, where the inspector listens on
// loopback only. The client runs as the runner's node, so the container's
// memory never includes it. Needs Linux, root through sudo, and Docker.

const MIB = 1024 * 1024;
const INSPECTOR_PORT = 9229;
const opened = new Set();

// Runs in the container's network namespace; its only output is the JSON.
const CLIENT = `
const address = 'http://127.0.0.1:${INSPECTOR_PORT}/json/list';
let targets;
for (let attempt = 0; !targets; attempt++) {
  try { targets = await (await fetch(address)).json(); }
  catch (error) { if (attempt === 20) throw error; await new Promise((r) => setTimeout(r, 250)); }
}
const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
const answer = new Promise((resolve) => { socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id === 1) resolve(message);
}; });
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
  expression: 'JSON.stringify(process.memoryUsage())', returnByValue: true } }));
const reply = await answer;
socket.close();
process.stdout.write(reply.result.result.value);
`;

/**
 * The service's Node process memory in MiB, and what lies outside V8's heap and
 * external buffers: native allocations, malloc arenas, code and stacks.
 */
export async function nodeProcessMemory(server, service) {
  const pid = await nodePid(await server.containerOf(service));
  if (!opened.has(pid)) {
    await must('sudo', ['kill', '-USR1', String(pid)]);
    opened.add(pid);
  }
  const usage = JSON.parse(
    await must(
      'sudo',
      [
        'nsenter',
        '--target',
        String(pid),
        '--net',
        process.execPath,
        '--input-type=module',
        '--eval',
        CLIENT,
      ],
      { timeout: 30_000 },
    ),
  );
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  const threads = Number(/^Threads:\s+(\d+)/mu.exec(status)?.[1]);
  const mib = (value) => Math.round((value / MIB) * 10) / 10;
  const { arenas, ...mapped } = mappedMemory(
    await must('sudo', ['cat', `/proc/${pid}/smaps`], { timeout: 30_000 }),
  );
  return {
    arenas,
    ...Object.fromEntries(
      Object.entries(mapped).map(([key, value]) => [key, mib(value)]),
    ),
    pid,
    threads,
    rssMib: mib(usage.rss),
    heapUsedMib: mib(usage.heapUsed),
    heapTotalMib: mib(usage.heapTotal),
    externalMib: mib(usage.external),
    arrayBuffersMib: mib(usage.arrayBuffers),
    outsideHeapMib: mib(usage.rss - usage.heapTotal - usage.external),
  };
}

// glibc gives each extra malloc arena its own heap: a mapping reserved at
// 64 MiB, aligned to 64 MiB, whose used part is read-write and the rest
// inaccessible. The main arena grows the program break ([heap]).
const ARENA_HEAP_BYTES = 64n * BigInt(MIB);
const KIB = 1024;

/**
 * Where the process's resident memory lies, in bytes: file-backed (code and
 * libraries), glibc's main heap, its extra arenas (and how many), and other
 * anonymous mappings (V8's heap and large allocations among them).
 */
function mappedMemory(smaps) {
  const regions = [];
  for (const line of smaps.split('\n')) {
    const header = /^([0-9a-f]+)-([0-9a-f]+) (\S{4}) \S+ \S+ \S+\s*(.*)$/u.exec(
      line,
    );
    if (header) {
      regions.push({
        start: BigInt(`0x${header[1]}`),
        end: BigInt(`0x${header[2]}`),
        perms: header[3],
        path: header[4],
        rss: 0,
        anonymous: 0,
      });
      continue;
    }
    const field = /^(Rss|Anonymous):\s+(\d+) kB$/u.exec(line);
    if (field && regions.length > 0)
      regions.at(-1)[field[1] === 'Rss' ? 'rss' : 'anonymous'] =
        Number(field[2]) * KIB;
  }
  const result = {
    arenas: 0,
    fileBackedRssMib: 0,
    mainHeapMib: 0,
    arenaMib: 0,
    otherAnonymousMib: 0,
  };
  for (const [index, region] of regions.entries()) {
    result.fileBackedRssMib += region.rss - region.anonymous;
    if (region.anonymous === 0) continue;
    const next = regions[index + 1];
    const reserved =
      next?.start === region.end && next.perms.startsWith('---')
        ? next.end - region.start
        : region.end - region.start;
    if (region.path === '[heap]') result.mainHeapMib += region.anonymous;
    else if (
      region.path === '' &&
      region.perms.startsWith('rw') &&
      region.start % ARENA_HEAP_BYTES === 0n &&
      reserved === ARENA_HEAP_BYTES
    ) {
      result.arenaMib += region.anonymous;
      result.arenas++;
    } else result.otherAnonymousMib += region.anonymous;
  }
  return result;
}

/**
 * The service's own Node process as the host sees it. Node names its main
 * thread, so `comm` won't do, and the Code runner's sandboxes run node too:
 * the service is the process running its built entry point.
 */
async function nodePid(container) {
  const listed = await mustDocker(['top', container, '-eo', 'pid,args']);
  const row = listed
    .split('\n')
    .map((line) =>
      /^\s*(\d+)\s+node\s+apps\/[\w-]+\/dist\/main\.js$/u.exec(line),
    )
    .find(Boolean);
  if (!row)
    throw new Error(`no service node process in ${container}:\n${listed}`);
  return Number(row[1]);
}

/** The memory limit Docker enforces on the service's container, in MiB. */
export async function containerLimitMib(server, service) {
  const bytes = Number(
    await mustDocker([
      'inspect',
      '--format',
      '{{.HostConfig.Memory}}',
      await server.containerOf(service),
    ]),
  );
  return bytes > 0 ? bytes / MIB : null;
}
