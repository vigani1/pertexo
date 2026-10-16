import { connect } from 'node:net';
import { lstat, unlink } from 'node:fs/promises';

/** A crashed manager may leave its socket file. An active listener is never replaced. */
export async function removeStaleSocket(path: string): Promise<void> {
  const existing = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  });
  if (existing === null) return;
  if (!existing.isSocket() || existing.uid !== process.getuid?.())
    throw new Error('Code socket path has another owner or file type');
  const stale = await new Promise<boolean>((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Cannot establish whether the Code socket is stale'));
    }, 1000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.destroy();
      if ('code' in error && error.code === 'ECONNREFUSED') resolve(true);
      else reject(error);
    });
  });
  if (!stale) throw new Error('A Code runner already owns this socket');
  const current = await lstat(path);
  if (current.ino !== existing.ino || current.dev !== existing.dev)
    throw new Error('Code socket ownership changed during startup');
  await unlink(path);
}
