export async function abandonResponse(
  response: Response,
  controller: AbortController,
): Promise<void> {
  controller.abort();
  if (response.body !== null && !response.body.locked) {
    await cancelBounded(() => response.body?.cancel() ?? Promise.resolve());
  }
}

export async function cancelBounded(
  cancel: () => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, 250);
    timeout.unref();
    Promise.resolve().then(cancel).then(finish, finish);
  });
}
