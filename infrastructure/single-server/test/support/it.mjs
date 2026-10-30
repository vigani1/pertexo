import { it as nodeIt } from 'node:test';

// node:test has no expected-failure form on Node 24. This one reads like Vitest's
// `it.fails`, so turning a known bug's test into `it` is the same one-word change.
export const it = Object.assign((name, body) => nodeIt(name, body), {
  fails: (name, body) =>
    nodeIt(`[known bug] ${name}`, async (context) => {
      let failed = false;
      try {
        await body(context);
      } catch (error) {
        failed = true;
        // Shown in the report, so the reason it fails today can be checked.
        context.diagnostic(String(error?.message).slice(0, 500));
      }
      if (!failed)
        throw new Error(`Passes now: change it.fails to it for "${name}"`);
    }),
});
