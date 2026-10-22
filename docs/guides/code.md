# Code

Use Code when a transform needs JavaScript or Python. For standard list, date and text
operations, the built-in data steps need less setup. Use HTTP Request to
contact a service; Code has no network access or credentials.

## JavaScript: input, variables and output

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
access inside Code is not statically checked or included in the variable-usage
list; missing properties or keys have the chosen language's normal behavior.

## JavaScript modules

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

## Python

Choose **Python** in Language. Existing Code steps default to JavaScript.
Switching a non-empty step asks for confirmation and keeps the source; edit it
for the new language, or Undo to restore the previous choice. A language change
makes an existing pin stale, like any other step setting change.

Python is a synchronous function body, with mapped `input` and the run's fixed
workspace values in `_vars`. Return ordinary JSON: dictionaries with string
keys, lists, strings, finite numbers, booleans or `None`. Convert dates,
Decimals and other Python objects explicitly. Integers outside
−9,007,199,254,740,991…9,007,199,254,740,991 must be returned as text to avoid losing
precision in JSON. NaN, Infinity, sets, tuples and custom objects fail with
`code.output_invalid`.

Transform a mapped list:

```python
return [
    {"name": row["name"].strip(), "total": row["amount"] * _vars["RATE"]}
    for row in input["rows"]
]
```

Convert a timestamp to a local date:

```python
from datetime import datetime
from zoneinfo import ZoneInfo

timestamp = datetime.fromisoformat(input["timestamp"])
return {"date": timestamp.astimezone(ZoneInfo("Europe/Paris")).date().isoformat()}
```

Use timestamps with an explicit offset, such as `2026-10-22T12:00:00+00:00`.
Timezone data is included. Hash a value:

```python
import hashlib

print("Hashing the mapped message")
return {"sha256": hashlib.sha256(input["message"].encode("utf-8")).hexdigest()}
```

Python runs on CPython **3.15.1** in the same isolated runner as JavaScript.
Allowed standard modules are json, math, statistics, datetime, time, zoneinfo, re,
decimal, fractions, itertools, functools, collections, string, textwrap,
hashlib, hmac, base64, uuid, random, urllib.parse, html, csv and io. The internal
`_strptime` date helper is also allowed so datetime parsing works. Use io for
in-memory CSV/text buffers; filesystem writes remain forbidden. No third-party
Python packages are preinstalled. Other imports, including os, sys, subprocess,
socket, ctypes, threading, multiprocessing, importlib, pickle and asyncio,
are refused. Import restrictions are defense in depth; the kernel/container
isolation remains the security boundary. There is no network or filesystem
write access. Use HTTP Request for external services.

## Test and inspect

The Setup tab highlights the chosen language and shows syntax errors without
running it. Python uses the editor grammar for local hints; Preview gives the
CPython compiler's authoritative error and source position, including syntax
the editor grammar may not recognize yet. The instance's effective time and
memory limits are shown there. Tab moves
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
| Source, either language | 64 KB |
| Time per step | 5 seconds by default, within the instance maximum |
| Instance maximum time | 30 seconds by default; configurable up to 300 |
| JavaScript heap | 128 MB by default; configurable from 32 MB to 1 GB |
| Python memory | Same shared instance setting and process RSS supervision |
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
`CODE_RUNNER_MAX_SECONDS`, `CODE_RUNNER_CONCURRENCY`, `CODE_RUNNER_PACKAGES`
and `CODE_RUNNER_PYTHON_PACKAGES`. Time, memory and concurrency are shared by
both languages; there is no separate Python pool.
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

For Python extras, build a custom image that installs pinned, audited packages
under `/opt/pertexo-python/lib/python3.15/site-packages`, then set
`CODE_RUNNER_PYTHON_PACKAGES='["package_import_name"]'` consistently for the API,
worker and runner. This setting uses Python import names, not PyPI distribution
names. The standard image has no pip: install packages in a build stage using
the same CPython version, then copy their runtime files into the custom image.
The runner refuses unavailable packages and standard-library modules configured
as extras. Package dependencies initialize in the task process; the setting
does not relax kernel isolation. Rebuild and run the existing hardened image
qualification before deployment.

The single-server deployment uses the hardened runner service. Local
`pnpm dev` uses a separate runner process with weaker isolation for development.
Install CPython 3.15.1 locally and ensure `python3.15` is on PATH to run Python
steps and the Python process tests. JavaScript-only development still works
without a local Python installation.
Deployed workers refuse that development mode before sending run data. See
[the deployment guide](../operations/single-server.md) for container limits and
configuration.
