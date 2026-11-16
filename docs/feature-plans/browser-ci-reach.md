# Browser CI reach

Feature-only pull requests select the mocked specs and live journeys in the
committed browser reach inventory. Shared web code, unknown paths, dependent
workspaces, main and schedules retain complete coverage. Backend changes retain
all live journeys. The inventory includes shell features, fixture-owned areas and imported feature dependencies;
`all` represents broad journeys. CI checks inventory completeness and feature names.

The existing longest-first duration assignment balances selected work over at most
two mocked jobs and three live jobs. Small selections use fewer jobs. The selector
passes explicit mocked file lists to the runner; full runs still discover disk
inventory. Mocked tests request reduced motion, with assertions unchanged and
three workers retained.

Validation: selector and inventory regressions, a planted wrong-feature mutation,
focused mocked profiles, full static checks, full PR CI and a disposable feature PR.
Profile evidence and CI timings live in the owner's uncommitted CI-D audit report.
