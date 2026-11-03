# File and directory naming

### Names

Use lowercase kebab-case for directories and the words in a filename. Use dots to separate a subject from a recognized role: `workspace-variables.store.ts`, `connections.repository.ts`, `slack-send-message.executor.ts`. Use `.tsx` when a file contains JSX. Exported TypeScript names keep their language conventions.

Name an operation with a complete verb and object: `advance-run.ts`, `validate-workflow-graph.ts`. A clear owning path may supply the object for a short private operation, such as `variables/replace.ts`. Name a concept with a concrete noun: `command-retry.ts`, `portable-manifest.ts`. A role suffix is useful when it tells the reader how the module participates; it is not required on every function or data model.

Choose the shortest subject that makes the file identifiable with its path. Repeat the directory's subject when it makes an editor tab, import, or search result clearer. Do not strip the subject from a filename to avoid repetition. Do not repeat an entire ancestor chain. `runs/advance/advance-run.ts` is fine.

Do not use `contract.ts`, `types.ts`, `utils.ts`, `helpers.ts`, or `common.ts` to avoid choosing a responsibility. Keep types and their small, related values together when they change together; name that concept. Use `<subject>.types.ts` only for erased type declarations and type-only re-exports. Use `<subject>.schemas.ts` for runtime schemas and closely related parsing/validation support. Do not split a coherent module solely to earn either suffix.

### Roles

| Role | Meaning |
|---|---|
| `<subject>.repository.ts` | Database access, reads and writes, including locks, row projections and persistence orchestration; it is not a promise of read-only behavior or of an ORM class. |
| `<subject>.store.ts` | A bound interface to state that assembles operations for its caller and owns or receives their state context and resource lifecycle; in core this is the flow facade, in the browser it is local state. |
| `<subject>.service.ts` | Application operations that adapt boundary requests and coordinate their dependencies; use one filename role for today's API `service` and `use-case` modules. |
| `<subject>.queries.ts` | Browser server-state query keys/options and reads for the query cache; backend database access uses `repository`. |
| `<subject>.api.ts` / `<subject>.mutations.ts` | Browser endpoint calls / mutation and cache-update definitions. |
| `<subject>.controller.ts` / `<subject>.module.ts` | Framework transport handlers / framework composition and dependency registration. |
| `<subject>.definition.ts` / `<subject>.executor.ts` | A step's declared identity, manifest and registration / its execution implementation. |
| `<subject>.errors.ts` | An error family and its boundary translation. |
| `<subject>.runtime.ts` | Construction and lifetime of live resources; a time helper is named as an operation instead. |
| `<subject>.validation.ts` | Semantic validation/inspection functions; schema declarations use `schemas`. |

These are roles, not new layers or mandatory files. Repositories may contain existing transaction orchestration. A filename change does not move authority, change transaction ownership or create an interface.

`index.ts` is an intentional re-export entry point, not an implementation. Keep `public.ts` and `<subject>.public.ts` for intentional browser feature interfaces. Keep `server.ts`, `main.ts`, `testing.ts`, `startup.ts`, database `schema.ts`/`primitives.ts`/`platform.ts`, and tool-defined configuration/declaration filenames in their existing roles. Do not make more entry points to make filenames uniform. ADR 091's core imports still reach the files named by an area's index directly.

### Directories

Start with a real area or feature. Inside it, introduce a sub-area when it has an independently describable responsibility. Use a role directory only to organize that sub-area's files; keep the web app's established `pages`, `components`, `hooks`, `data`, `forms`, `model` layout. Do not create top-level collections of all repositories or controllers.

A single-file directory is useful when it is a genuine area, a deliberate interface, or a required role slot shared with peer areas. Otherwise prefer a descriptive file in its parent. Do not create empty slots for imagined future code.

About ten direct files prompts a review, not a forced split. Keep eleven to fifteen related files together if splitting would add navigation without separating a responsibility. A deliberate catalog of directly named peer items, such as UI primitives, can be larger. Prefer at most four directories below `src`; review five or more. Neither number justifies moving code without a better grouping.

### Tests

Keep tests in the existing workspace `test/` tree and browser `e2e/` or `e2e-live/` trees. Mirror the owning area, then name the behavior or scenario. A file can name a topic (`quotas.test.ts`); a behavioral name must finish its thought (`retains-pending-charge-until-deletion.cases.ts`). Put full statements in `it` descriptions. Never shorten a name by truncating words, acronyms or a sentence.

Use `.test.ts` for discovered tests, `.integration.test.ts` for the existing integration lane, and `.spec.ts` for Playwright. An imported module that registers cases keeps `.cases.ts`; it must be called by a discovered suite, not discovered a second time. Keep fixtures and test support beside the tests they serve. Tests sharing one fixture lifecycle stay under their owner; do not invent one test file per source helper.

