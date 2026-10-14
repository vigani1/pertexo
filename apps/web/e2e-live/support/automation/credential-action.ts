/** Playwright failures can include bearer headers or a matcher snapshot of the receipt. */
export async function withOwnedCredential<Value>(
  action: () => Promise<Value>,
): Promise<Value> {
  try {
    return await action();
  } catch {
    throw new Error(
      'Owned automation credential action failed; sensitive details omitted.',
    );
  }
}
