# Local checks

`pnpm format:changed` checks tracked changes against `origin/main` and new,
non-ignored files. Pass another Git reference, such as `HEAD`, to check local
edits against it. Deleted files are omitted; filenames with spaces remain intact.
Pre-push uses this command. CI still runs whole-tree `format:check`.

Formatting configuration, package manifests and pnpm lock/configuration changes
fall back to the whole tree: those inputs can change formatting of files that
were not edited. A routine source-only change uses the narrow path.

Typechecking keeps every existing project and strictness setting. Test projects
inherit incremental compilation, with the web test project using a cache separate
from the app project. A clean checkout still checks everything; later checks
reuse TypeScript's dependency-aware cache. Cache files are ignored by Git.

J2 measured a source-only selection at 1.68 seconds versus 99.84 seconds for the
whole tree on the same checkout under concurrent validation. Earlier whole-tree
formatting took 32.16 seconds, illustrating host-load variation. Configuration
and tool changes deliberately take the whole-tree path.

Cold creation of the separated type caches took 66.37 seconds; a subsequent
complete typecheck took 13.71 seconds, compared with 42.73 seconds before the
cache change. The local J2 evidence verifies changed/untracked invalid files,
configuration fallback, deleted paths and a new type error after a warm pass.
