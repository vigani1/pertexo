# Code

Use Code when a transform needs JavaScript. For standard list, date and text
operations, the built-in data steps need less setup. Use HTTP Request to
contact a service; Code has no network access or credentials.

## Input, variables and output

Write the body of an async function. `input` is the value configured in the
step's Inputs tab. `$vars` contains the workspace variables captured when the
run or preview started. Those values are frozen; replay and recovery keep the
same variable revision.

```js
const _ = require('lodash');
console.info(`Summarizing ${input.rows.length} rows`);
return _.map(_.groupBy(input.rows, 'currency'), (rows, currency) => ({
  currency,
  total: _.sumBy(rows, 'amount'),
}));
```

Return a plain JSON value: an object, array, string, number, true/false or null.
Dates must become strings. Buffers must become strings or arrays. Functions,
class instances, undefined, non-finite numbers, cycles and sparse arrays fail
with `code.output_invalid`. Unsupported text, including NUL in the returned
value, also fails. Use Read file before Code to turn a file into JSON.

Workspace variables are non-secret values, not environment variables. Property
access inside arbitrary JavaScript is not statically checked or included in
the variable-usage list; missing properties have normal JavaScript behavior.

## Modules

`require` and `await import(...)` can load these Node built-ins:

`assert`, `buffer`, `crypto`, `events`, `path`, `querystring`, `string_decoder`,
`url`, `util`, `zlib`.

Lodash and Day.js are installed. Static `import` statements do not work inside
an async function body. For a package that requires ESM, use `await import`.

```js
const dayjs = require('dayjs');
return { date: dayjs(input.timestamp).toISOString(), rate: $vars.RATE };
```

Other built-ins are refused, including `fs`, `net`, `http`, `https`,
`child_process`, `worker_threads`, `vm`, `module` and `os`. There is no
`process`, `fetch` or `WebSocket`. Code cannot install packages at runtime,
write files, start processes or access another run's data.

## Test and inspect

The Setup tab highlights JavaScript and shows syntax errors without running
it. The instance's effective time and memory limits are shown there. Tab moves
focus out of the editor. Use Ctrl+[ and Ctrl+] to change indentation (⌘ on
macOS).

In Test, enter JSON or use an earlier step's test output. Tests run on the same
worker and Code runner as published runs. Inspect the returned JSON and console
messages. If you pin a sample, tests return that saved output without executing
Code. Published runs always execute the published code. Changing the code or
time limit makes that step's pin stale until you confirm or replace it.

Console output and bounded error details are private run data for people who
can read that run. Run details keep them for 30 days; previews keep them for
7 days. They never enter failure summaries, notices, audit records or email.
Logs are recorded with the completed attempt; a crash or cancellation may leave
no diagnostics.

## Limits

| What | Limit |
| --- | --- |
| JavaScript source | 64 KB |
| Time per step | 5 seconds by default, within the instance maximum |
| Instance maximum time | 30 seconds by default; configurable up to 300 |
| JavaScript heap | 128 MB by default; configurable from 32 MB to 1 GB |
| Concurrent Code tasks | 2 by default; configurable from 1 to 16 |
| Retained JSON output | 256 KB, depth 64, up to 10,000 members |
| Console output | 64 KB, up to 200 messages, up to 2,048 characters per message |

Sizes include UTF-8 encoding and JSON framing where applicable. The runner
transport's larger envelope does not increase the retained output limit. Split
large transformations into smaller runs. Excess console output is visibly
truncated. Infinite loops and memory failures terminate the task process.

Code is safe to repeat because it cannot change anything outside its isolated
process. Temporary runner unavailability uses the normal safe retry path;
syntax, runtime, timeout, memory, module and output failures need correction or
a deliberate retry. Failure routes can handle the closed `code.*` error codes.

## Instance configuration

The administrator controls `CODE_STEPS_ENABLED`, `CODE_RUNNER_MEMORY_MB`,
`CODE_RUNNER_MAX_SECONDS`, `CODE_RUNNER_CONCURRENCY` and `CODE_RUNNER_PACKAGES`.
Turning Code off refuses new publications containing it and fails existing
Code steps with `code.disabled`. Lowering the instance time maximum below a
published step's explicit timeout also requires correcting that step.

Extra packages must be installed in a custom image, pinned and audited:

```sh
pnpm --filter @pertexo/code-runner add --save-exact package-name@version
```

Rebuild and qualify the image, then add the installed package name to
`CODE_RUNNER_PACKAGES='["package-name"]'`. Packages must work within the same
isolation restrictions; this setting cannot enable networking, native addons,
processes or filesystem writes. Worker and runner settings must agree.

The single-server deployment uses the hardened runner service. Local
`pnpm dev` uses a separate runner process with weaker isolation for development.
Deployed workers refuse that development mode before sending run data. See
[the deployment guide](../operations/single-server.md) for container limits and
configuration.
