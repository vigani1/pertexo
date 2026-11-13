# Step setup drawn from the catalog schema

Status: built (option B, batch J6b). Finding: web-gaps-05. Related:
[F21](21-integrations-and-polling.md).

## As built

- Labelled choices use `labelledChoice` from `@pertexo/node-sdk`: one record
  gives both the stored `enum` and its `oneOf` `{ const, title }` words.
- Starting values are `default` in the schema. A union carries a whole valid
  starting setup as its own `default` (Text starts on Trim, not on its first
  shape); a flat step uses each property's `default`. New `default`s use
  `.meta()`, so runtime parsing doesn't change. A catalog test validates every
  `default` against the schema it sits in.
- Validate now starts empty: its old starting `{ rules: [] }` broke its own
  schema (one rule at least). Every other step starts exactly as before, which
  a web test checks across the whole catalog.
- Wait, Read file, Create file and Schedule keep their own builders, which
  name their choices themselves. Wait has no `const` discriminator, and adding
  one would change its stored format.

## Measurement (2026-11-12, main at `8dd36b6c4`)

Method: a static pass over the compiled `PLATFORM_NODE_CATALOG` (each step's
config JSON Schema, sorted by shape), and a search of `apps/web/src` for
step-key literals (`'core.*'`, `'http.*'`, `'slack.*'`, `'email.*'`), test files
excluded. Both scripts and their output are in the batch J7 evidence.

| Catalog shape (44 steps)                                    | Steps | Drawn today by                    |
| ----------------------------------------------------------- | ----: | --------------------------------- |
| No config (set up by input mappings)                        |    10 | nothing needed                    |
| Flat primitives and enums                                   |    13 | the generic renderer              |
| One `oneOf` per operation or format (Text, Date, Wait, …)   |    10 | small per-type builders or tables |
| Nested objects or lists (Switch, forms, tables, HTTP, …)    |    11 | custom builders                   |

- 38 web source files name a step key. The inspector is 19,021 lines in 120
  files, up from 17,130 when the finding was written.
- The literals sit in five groups:
  1. **Words the schema could carry:** `transforms/fields.ts` (option labels and
     field descriptions for 11 steps), `operation-fields.ts`,
     `utility-config.ts`, and the `STARTING` table in `graph/starting-config.ts`
     (starting values for 24 steps). That's about 300 lines.
  2. **Choosing a builder:** the key maps in `tabs/setup-controls.tsx`,
     `tabs/setup.tsx` and `editor.tsx` (about 20 literals).
  3. **Per-type union builders** that only switch fields by operation:
     `utility-setup.tsx`, `date-setup.tsx` and part of `wait/setup.tsx`. That's
     about 220 lines.
  4. **Graph meaning** that a schema can't express: Merge joins its Parallel,
     Condition and Switch ports, and Call targets. These literals stay.
  5. **Browser choices:** icons in `catalog/model/steps/registry.ts`, add-step
     groups, run sentences and error copy. They stay in the browser.
- The custom builders that earn their place (Switch, Parallel, Validate, file
  formats, Condition, schedule, HTTP body, human tasks, Code and tables) are
  about 6,000 lines. A UI-hint contract would not remove them.

## Problem in plain words

The catalog sends a correct JSON Schema for every step, but the browser draws
only flat settings from it. Every step whose setup changes with an operation,
and every label, description and starting value, is written again in the web
app. Today that duplication is roughly 500 lines, not the whole inspector. The
real cost comes later: under F21, each provider operation would need either
its own React builder or an "Edit as JSON" box.

## Options

| Option | What                                                                                                                                                                                                                                                                              | Cost                                                                                    | Removes                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A      | Keep things as they are; add a builder per provider operation under F21.                                                                                                                                                                                                         | Nothing now; about 100–300 lines of React per provider operation later.                 | Nothing.                                                                                              |
| B      | **Standard JSON Schema only.** Node definitions put `title`, `description` and `default` on their Zod schemas, and enum labels as `oneOf: [{ const, title }]`. The generic renderer learns `oneOf` unions keyed by a `const` field, plus one level of nested object.              | M: node-sdk/nodes-core schema metadata, one renderer extension, contract snapshot.      | Groups 1 and 3 (~500 lines and ~30 literals). Unions need no extra hint: the discriminator is in the schema. |
| C      | B plus a Pertexo `x-ui` extension (order, widget, show-when, groups) and a renderer for lists and nested groups.                                                                                                                                                                  | L: new contract vocabulary, validation, renderer for arrays and widgets, docs.          | Also some of group 2. The big builders (group 4 and the ~6,000 lines) stay.                           |

## Recommendation: option B

B removes the duplication that exists today, using only vocabulary that JSON
Schema and Zod already have, so no new contract format is needed. It also gives
F21 provider operations (mostly flat fields with an operation choice) a form
without React code. Option C fails the two-question test for now. Its extra
power (widgets, list editors, show-when across fields) has no concrete user yet,
and adding `x-ui` later, when the first provider needs it, is no harder than now.
Revisit C when an F21 slice needs a field that B can't draw.

## What it would change

- `packages/nodes-core` (and `integrations` step definitions): Zod `.meta()`
  titles and descriptions, enum labels, and `.default()` starting values within
  bounds. `node-sdk` serializes them in the catalog's `configSchema`, and the
  catalog contract stays the same shape.
- `apps/web/.../model/inspector/draft.ts`: read `title`, `description`,
  `default` and labelled `oneOf` enums. Add a union field set that switches on
  the `const` discriminator and keeps the matching fields when the operation
  changes. Add one level of nested object.
- `graph/starting-config.ts` takes defaults from the schema. Merge's
  join-the-Parallel rule and the human-task schema parses stay.
- Delete `transforms/fields.ts`, `operation-fields.ts`, `utility-config.ts`,
  `utility-setup.tsx` and `date-setup.tsx`, plus their entries in the builder
  maps.
- No new endpoint, table, migration or ADR. The stored config format doesn't
  change.

## Tests that would prove it

- Catalog contract: each of the 10 union steps exposes a labelled `const`
  discriminator. Every `default` passes its own schema (one table-driven test
  over the whole catalog).
- Web unit tests, from the user's view: adding Text, Date, Number, Crypto, XML,
  HTML and Wait shows the same fields, labels and starting values as before.
  Switching an operation keeps shared values and drops the others. Unsupported
  shapes still fall back to "Edit as JSON".
- One editor browser journey adds a Date step, changes its operation, saves and
  reloads, then checks the stored config is unchanged from today's builder.
- Existing saved workflows open without a config change: run the draft
  round-trip tests over the curated templates.
