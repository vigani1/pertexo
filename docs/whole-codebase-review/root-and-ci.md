# Root, build and CI review

Scope: all 26 frozen root/hidden-root files. Primary reviewer read all authored
text. The 5,714-line lockfile is generated data: all importer declarations were
read, all 19 were compared with package manifests, and all 577 package and 577
snapshot records were parsed. No importer mismatch, absent registry integrity,
or non-registry resolution was found. This is dependency consistency evidence,
not a current vulnerability scan or license approval.

## File-by-file disposition

| File | Judgment | Specific reason / follow-up |
| --- | --- | --- |
| `.dockerignore` | KEEP | Excludes Git metadata, all local env files, generated output, dependencies and docs from the build context. Stage-installed dependencies and freshly compiled output are explicit inputs. |
| `.env.example` | KEEP | Clearly local-only synthetic credentials, role-separated URLs and explicit external-service placeholders; explains local emulation limitations and restore-before-serve requirements. Do not promote defaults to deployment credentials. |
| `.githooks/pre-push` | KEEP / TEST | Delegates `pnpm prepush:check`, respects failure and has an explicit emergency opt-out. It does not itself invoke the full isolated mutation runner. Git isolation work remains WQ-223 for subprocesses acting on explicit repositories. |
| `.github/CODEOWNERS` | KEEP | One visible owner plus critical-path routes. Routing is not proof required code-owner approval is enabled; preserve the documented solo-maintainer exception. |
| `.github/dependabot.yml` | KEEP | Exact ecosystem scope, bounded PR counts, minor/patch grouping and deliberate major-update review. Docker Node-major exclusion aligns with runtime policy. Do not claim this file updates every Compose digest automatically. |
| `.github/workflows/ci.yml` | FIX / TEST | WQ-231. Explicit least-privilege workflow token, pinned actions/images, job timeouts, isolated Compose projects, build/coverage/report steps and always-cleanup are good. Ordinary PR CI omits several gates present in local `check`. |
| `.github/workflows/codeql.yml` | KEEP | Separate bounded security-analysis job with pinned actions, read contents and security-event write permission. No privileged `pull_request_target` checkout/execution. Actual GitHub required-check status is external evidence. |
| `.github/workflows/release-gate.yml` | KEEP / TEST | Reuses real-service CI and adds `release:check`; manual/weekly release qualification does not replace omitted PR gates. Coordinate WQ-231 without duplicating all work or renaming protected checks casually. |
| `.gitignore` | KEEP | Protects local env files while permitting the public example; omits compiled/runtime/dependency outputs. Keep new audit artifacts explicit first-party docs, not hidden generated runtime data. |
| `.mailmap` | KEEP | Narrow author identity normalization; no execution, runtime secret or behavior change. |
| `.node-version` | KEEP | Node 24 major agrees with package engine, CI and container family. Major-family development pin versus exact production image pin is intentional. |
| `.prettierignore` | KEEP | Excludes generated artifacts, lockfile, user/project instructions and documentation from broad formatter rewrites. Markdown correctness is a separate docs gate. |
| `.prettierrc.json` | KEEP | Small consistent style policy; does not try to encode semantic readability as formatting. |
| `AGENTS.md` | KEEP | Distinguishes planned checkpoints from ordinary work, requires scoped skills, dirty-work preservation and explicit commit/push authority. This audit does not reopen settled ADRs or grant implementation authority. |
| `CONTEXT.md` | KEEP | Concise distinctions among lifecycle, activation, workflow restoration, version restoration and run replay. These names prevent real state conflation; retain them in refactors. No terminology change proposed. |
| `CONTRIBUTING.md` | KEEP | Accurate local hook/static/integration separation, security-report routing and change-evidence expectations. WQ-231 is needed for CI parity, not permission to delete tests or bypass protected checks. |
| `Dockerfile` | KEEP / CONDITIONAL | Explicit build/production-dependency/runtime stages, frozen installs, pinned base and patch checksums, non-root UID and role closure. Security patch rationale is a recorded claim; revalidate advisories/scans during authorized image updates, not rewrite pinned bytes based on age. Current explicit patch files support amd64/arm64; a new architecture requires its own qualification. |
| `README.md` | KEEP | Honest backend-only/in-progress scope, compiled-workspace development instructions, local services and separate qualification commands. No claim of production readiness; maintain status links as findings are implemented. |
| `SECURITY.md` | KEEP / CONDITIONAL | Private disclosure, current-main support and non-waiver of known defects are clear. Secret scanning/protected-check enablement is a GitHub setting, not proven by repository text; retain externally dated evidence per governance runbook. No network settings were changed or requalified. |
| `compose.yaml` | KEEP | Local services bound to loopback, explicit volumes, health checks, role bootstrap and independent ledger emulators. Default passwords are intentionally development-only. Per-run project/volume ownership belongs to the quality runner; never apply destructive cleanup to a user's default Compose project. |
| `eslint.config.mjs` | KEEP | Type-aware source/test scopes, explicit leaf-package restrictions, public database capability imports and browser-entry bans encode different dependency policies. Flat-config overrides justify some repeated lists; retain them rather than factor into a misleading universal denylist. Improve only if policy snapshots demonstrate equivalence. |
| `package.json` | FIX / KEEP | WQ-231. Explicit scripts and versions preserve the build and established test runners. `check`, `prepush:check`, integration and isolated qualification have distinct documented costs. Do not introduce buildless TypeScript or make default pre-push start destructive fixtures. |
| `pnpm-lock.yaml` | DATA / KEEP | All 19 importers agree with package manifests; 577 registry package records retain integrity, with matching snapshot count. Peer-resolution variants and optional platform packages are generated dependency graph data, not duplication to manually deduplicate. |
| `pnpm-workspace.yaml` | KEEP | Explicit workspace discovery, scoped security/compatibility overrides and dependency-build allow/deny policy. Preserve approved provider/runtime decisions; update lockfile only alongside authorized dependency changes. |
| `tsconfig.base.json` | KEEP | Strictness, optional-property/indexed-access safeguards, unknown catches and decorator metadata match existing Nest/TS build. `skipLibCheck` is not an application validation bypass; no speculative compiler rewrite. |
| `tsconfig.json` | KEEP | Explicit 18 project references match the workspace foundation and compile before tests consume exports. WQ-231 makes their validation continuous in PR CI. |

## WQ-231 — Keep required local invariants in ordinary PR CI

**P2 FIX / TEST.** Exact locations: `package.json:32–35` (`check` and architecture
scripts), `.github/workflows/ci.yml:119–134` (quality commands),
`:168–206` (workspace unit partition), and
`.github/workflows/release-gate.yml:42` (`release:check`). The current CI quality
list includes build/lint/typecheck and the unit matrix runs workspace tests.
Neither path invokes:

```text
pnpm architecture:check
pnpm built-exports:check
pnpm quality:local:check   # runner definition tests + performance:local:check
```

Parsing the CI YAML confirmed all three commands, and the nested
`performance:local:check`, are absent from ordinary CI steps. The weekly/manual
release path eventually runs `pnpm check`, but that does not protect every PR.
These are materially different invariants: project-reference/import ownership,
built export closure, and infrastructure runner/benchmark contract regressions.
Linting and package unit tests do not automatically cover them.

Implementation:

1. Add the missing service-free gates to the ordinary quality job, preserving
   build-before-built-exports ordering. Account for the child-process tests'
   duration; retain a bounded job. Do not add full `quality:local` or mutation
   execution to this static job. Integration's existing mutation step remains
   a separately owned service-backed operation.
2. Add a small test/validator of the required gate mapping across root scripts,
   CI and local qualification. Parse YAML and script names; do not snapshot
   whitespace or make arbitrary shell parsing the policy. Each required gate
   needs an identified CI owner, with deliberate exclusions stated separately.
   Synthetic fixtures should prove omission, duplicate/misordered build closure
   and unknown command are detected.
3. Preserve the existing protected check names. If a reviewed change moves gates
   to a new job, update GitHub required contexts with explicit user authority
   and retain the external response/merge-blocking proof. No branch-protection
   setting is changed by this plan.
4. Re-run the affected gate tests plus docs/CI validation locally. Require a PR
   run on the exact implementation revision before claiming hosted CI executes
   them. Existing local test success does not establish branch protection.

Dependencies: WQ-223/WQ-225/WQ-229 improve safety of runner tests and process
failure paths; none is a reason to weaken checks. Keep policy centralized at
the smallest useful mapping, not a new workflow-generation framework. Scope is
gate completeness and reviewability, not cosmetic YAML deduplication.
