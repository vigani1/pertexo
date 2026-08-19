# ADR 009: Restricted JSONata evaluation

- **Status:** accepted
- **Date:** 2026-08-20

## Context

Workflow mappings need more than literal and path lookup, but evaluating an
open-ended expression language in an API or execution worker would expose host
capabilities, nondeterministic values, and unbounded computation. Preview and
runtime evaluation must also agree: a preview result is unsafe guidance if the
published workflow later uses a different language profile or context.

## Decision

JSONata is the only V1 expression language, exposed through one platform-owned
evaluator in `workflow-model`. Callers submit JSON-compatible input, an
expression, an evaluator policy version, and an `AbortSignal`; they never
receive the JSONata library object or register functions or bindings. Preview,
manual node tests, publish validation, and workflow execution use this same
evaluator and the same policy constants.

### Deterministic context and result

Policy version 1 evaluates against one immutable, null-prototype JSON value
assembled by the value-source resolver:

```ts
type ExpressionContextV1 = Readonly<{
  runInput: JsonValue
  nodeOutputs: Readonly<Record<NodeId, JsonValue>>
}>
```

Only completed upstream nodes declared by the graph are present in
`nodeOutputs`. Credentials, environment variables, request objects, database
clients, loggers, clocks, random sources, prototypes, class instances, and
other host objects never enter the context. The boundary rejects cycles and
non-JSON values, structured-clones the accepted data, reconstructs objects with
null prototypes inside the evaluator thread, and canonicalizes object keys
before evaluation and before result comparison. Evaluation cannot mutate the
supplied context.

The public result is a discriminated union:

```ts
type ExpressionResult =
  | { kind: "value"; value: JsonValue; canonicalBytes: number }
  | { kind: "missing" }
  | {
      kind: "error"
      code:
        | "invalid_expression"
        | "disallowed_construct"
        | "limit_exceeded"
        | "timed_out"
        | "canceled"
        | "evaluation_failed"
      message: string
      limit?:
        | "expression_bytes"
        | "ast_depth"
        | "ast_nodes"
        | "input_bytes"
        | "input_depth"
        | "input_members"
        | "output_bytes"
        | "output_depth"
        | "output_members"
        | "pool_capacity"
    }
```

JSONata's no-match/JavaScript `undefined` result becomes `missing`; it is never
coerced to an empty string, `null`, or a successful value. All other results
must be JSON-compatible and pass the output limits. Messages may aid a user but
control flow depends only on the stable `code`.

### Allowed language profile

The evaluator parses the expression and walks its AST before execution. V1
allows:

- JSON literals, field and index lookup, parenthesized blocks, array and object
  construction, filters, and the single-level wildcard;
- arithmetic, comparison, boolean, concatenation, range, conditional, Elvis,
  and null-coalescing operators; and
- direct calls to this pure built-in allowlist: `$string`, `$number`,
  `$boolean`, `$not`, `$exists`, `$type`, `$count`, `$sum`, `$min`, `$max`,
  `$average`, `$append`, `$reverse`, `$distinct`, `$join`, `$substring`,
  `$substringBefore`, `$substringAfter`, `$uppercase`, `$lowercase`, `$length`,
  `$trim`, `$pad`, `$keys`, `$lookup`, `$merge`, and `$spread`.

The validator rejects every callable not explicitly listed. V1 also rejects
function definitions and lambdas, variable binding or assignment, partial or
dynamic function application, function chaining, higher-order functions,
regular-expression literals and regex-taking operations, the transform
operator, descendant wildcard, `$eval`, `$now`, `$millis`, `$shuffle`, and any
extension or host-registered function. Property names that happen to match
these tokens remain ordinary data; validation is based on the parsed AST, not
substring matching.

This is intentionally smaller than full JSONata. A new construct or built-in
requires a new policy version plus determinism, resource-limit, and capability-
escape tests; library upgrades do not silently expand the profile.

### Versioned limits

Policy version 1 uses these inclusive limits, measured on canonical UTF-8 JSON
unless stated otherwise:

| Resource | V1 limit | Enforcement |
| --- | ---: | --- |
| Expression source | 16 KiB | Before parse and at publish |
| Parsed AST depth | 64 | After parse and at publish |
| AST nodes | 2,048 | After parse and at publish |
| Input | 1 MiB | Before isolation boundary |
| Input container depth | 64 | Before isolation boundary |
| Input array/object members | 10,000 total | Before isolation boundary |
| Evaluation wall time | 100 ms | Hard runtime deadline |
| Evaluations active per process | 4, or available CPU count when lower | Pool admission |
| Evaluations queued per process | 128 | Pool admission |
| Evaluator old-generation heap | 32 MiB per thread | Worker resource limit |
| Evaluator young-generation heap | 8 MiB per thread | Worker resource limit |
| Evaluator stack | 4 MiB per thread | Worker resource limit |
| Output | 1 MiB | Before returning a value |
| Output container depth | 64 | Before returning a value |
| Output array/object members | 10,000 total | Before returning a value |

One KiB is 1,024 bytes and one MiB is 1,048,576 bytes. Expression size is the
UTF-8 source length. AST depth counts the root and every node on the longest
root-to-leaf path. Container depth is zero for a scalar and one for a root
array or object; member count is the sum of every array element and object
property recursively. An expression at a limit is accepted; one unit over is
rejected. Byte counts exclude evaluator envelopes. Input accounting covers the
complete context, not each source independently. Runtime rechecks every limit
even after publish validation because preview inputs and retained workflow
versions are untrusted boundaries.

### Isolation, timeout, and cancellation

Evaluation runs in a dedicated Node worker thread that receives only the
validated expression, policy version, and structured-cloned JSON context. The
thread module exposes no application services or registered functions. Each
thread has the memory and stack resource limits above. The bounded pool limits
concurrent evaluations and queue admission; the 129th queued evaluation fails
with `limit_exceeded` and `limit: "pool_capacity"` rather than creating
unbounded threads or work.

The caller starts the 100 ms deadline when the worker begins evaluation, not
while it waits for admission. On deadline or abort, the supervisor terminates
that worker thread, discards any late message, returns `timed_out` or
`canceled`, and replaces the thread before accepting more work. Cooperative
promises or JSONata callbacks are not trusted to stop computation. The process
shutdown signal aborts queued and active evaluations. Termination is the V1
hard-stop boundary; moving evaluation to an OS-sandboxed subprocess or
capability service remains an option if adversarial testing shows the library
can cross the interpreter boundary.

### Policy and library versioning

Every expression-bearing published workflow version pins
`{ language: "jsonata", policyVersion: 1 }`. The JSONata package is pinned by
the lockfile, and the evaluator records its package version in diagnostics and
proof output. Unknown policy versions make a draft readable but not
publishable or executable. Changing syntax, built-ins, context shape, limits,
missing-value behavior, or a JSONata dependency in a way that can change
results requires a compatibility review and normally a new policy version.
Retained versions continue through their pinned evaluator or an explicit,
tested runtime migration; they never fall forward silently.

### Phase 0E executable proof

Phase 0E does not satisfy this ADR with prose or unit mocks. Its fixture and
automated failure tests must run the production evaluator and record measured
elapsed time, canonical result checksum, evaluator package version, and policy
version. The proof must demonstrate:

1. representative allowed navigation, construction, operators, and every
   allowed built-in produce the expected canonical JSON;
2. `$eval`, clock/random access, function definitions, dynamic calls, regex,
   transforms, descendant traversal, unlisted functions, and attempted
   `process`, `require`, constructor/prototype, filesystem, and network access
   are rejected before execution or cannot cross the evaluator boundary;
3. expression bytes, AST depth/node count, input bytes/depth/member count, and
   output bytes/depth/member count each accept an exact-limit fixture and
   reject a one-over fixture with `limit_exceeded` and the exact `limit`
   discriminator;
4. a deliberately expensive allowed expression is terminated at 100 ms,
   returns `timed_out` within 250 ms total supervisor time, and the replacement
   worker successfully evaluates the next expression;
5. caller cancellation terminates active work, queued cancellation never
   starts, shutdown drains or terminates the pool, and no late result is
   observed;
6. absent paths return `missing`, malformed/disallowed expressions and runtime
   failures return their exact typed codes, and no case silently substitutes a
   value; and
7. the same expression and context evaluated 100 times across at least two
   workers and after pool restart yields byte-identical canonical output and
   checksum, while preview and runtime adapters yield the same result.

Any capability escape, deadline breach beyond the supervisor bound, unbounded
result, or nondeterministic canonical result fails the expression spike and
therefore the ADR 005 custom-engine gate.

## Consequences

V1 gains expressive mappings without exposing a general-purpose scripting
environment, and preview/runtime parity is a testable contract. The trade-off
is that familiar JSONata features are intentionally unavailable, worker-thread
termination and pool replacement add operational cost, and policy evolution
requires explicit compatibility support. Worker threads provide a hard
computation stop but are not claimed to be a general hostile-code OS sandbox;
the AST capability boundary and executable escape suite must pass before the
custom engine proceeds.
