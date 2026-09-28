// Isolated IPC/shutdown probe: no database, queue, browser or credentials.
let closePromise: Promise<void> | undefined;
let closes = 0;
const close = () => {
  closePromise ??= Promise.resolve().then(() => {
    closes += 1;
  });
  return closePromise;
};
async function finishShutdown(): Promise<void> {
  await close();
  if (process.connected && process.send !== undefined) {
    await new Promise<void>((resolve, reject) => {
      process.send?.(
        { phase: 'worker-shutdown', success: true, closes },
        (error: Error | null) => {
          if (error === null) resolve();
          else reject(error);
        },
      );
    });
  }
  if (process.connected) process.disconnect();
}
const stop = () => {
  void finishShutdown();
};
process.once('SIGTERM', stop);
process.once('disconnect', stop);
console.log('ready');
