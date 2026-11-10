# CI timing review — 2026-11-10

The batch J2 review sampled the 12 successful main runs in the latest 15 CI runs.
Created-to-`ci-passed` completion had a median of **17.05 minutes**, with a range
of 15.2–58.2 minutes. Total workflow created-to-updated time had a median of
52.58 minutes; that includes work outside the required gate and is not a gate
latency measurement. Raw run and job JSON is retained in the local J2 evidence.

In inspected run 42692374195, the slowest gated legs were the x86 self-host drill
(17.68 minutes), live browser 2 (13.85), services integration (13.52), mocked
browser 2 (13.47), worker integration (13.35), web units (12.35), and static check
(10.17). The fault job took 48.67 minutes outside the gate.

Keep the existing required checks and publishing policy. Docs-only routing and
browser sharding already exist; the current numbers do not justify another CI
job, a new build-distribution subsystem or relaxing required checks. Further CI
work should compare per-step setup/build/test times and queue delay separately,
then demonstrate a lower gate duration under the same checks.

