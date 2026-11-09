# Workflow run stream capacity measurement

J1 measured the current implementation on 2026-11-09. This is a measurement,
not a change to authorization or stream lifetime. The five-second maximum age of
an authority fact and the one-second lookup budget remain unchanged.

## Method

A fresh single-server fixture published a webhook→Code→end workflow and completed
one run. One authenticated actor opened 0, 1, 10, then 100 independent SSE
connections to that same terminal run. Each cohort was observed for at least 35
seconds after all response headers arrived. The client had a header deadline but
no idle timeout after SSE acceptance, and closed the connections only after the
window. There were no run events generated during the windows.

The main cost sample retained the qualification's memory caps, including 512 MiB
API/worker containers and 256 MiB heaps. API and PostgreSQL CPU were unrestricted,
as in the normal production Compose file; this sample is **not** a 2-vCPU host
qualification. The shared ARM64 Docker VM's resources were unchanged. The separate
[minimum-host qualification](single-server.md#qualification-method-and-limits)
used service quotas totalling 4 GiB and 2 vCPUs and included publishing, Code runs
and an editor session.

Database rates are deltas of `pg_stat_statements` calls in the fixture database,
including worker/background work and transaction/authority/reconciliation SQL.
They are not counts of logical authorization decisions. CPU is the API cgroup's
CPU-time delta divided by elapsed time, expressed as a percentage of **one core**.
Redis clients come from `INFO clients`. Observation windows were 35.46–35.81 s;
connection opening and replay preceded the window.

## Results

| Open terminal streams | Database statements/s | API CPU, one core | Redis clients | Streams ended by server during observation |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 52.70 | 2.05% | 16 | 0 |
| 1 | 58.70 | 2.90% | 17 | 0 |
| 10 | 150.39 | 7.88% | 17 | 0 |
| 100 | 1,134.96 | 51.63% | 17 | 0 |

At 10–100 streams, subtracting the idle baseline gives roughly 10 additional SQL
statements per second per open terminal stream. Statements referencing
`auth_sessions` totalled 0, 18, 326 and 3,781 across the respective windows (two
query families). Authority checks and durable reconciliation remain per stream.
The shared subscriber adds one Redis client to this process, rather than one per
viewer. These measurements concern one actor/workspace/run and a warm process;
other principals and workloads may have different cache behaviour.

All 100 terminal streams remained open beyond the 35-second window with CPU
unrestricted. Completing a run does not, by itself, reclaim these subscriptions
within that observed interval. This is a lower bound on lifetime, not a claim of
infinite lifetime.

## Constrained burst observation and limits

Under the fixed 4 GiB / 2-vCPU qualification allocation (API quota 0.5 vCPU,
PostgreSQL quota 0.2 vCPU), opening 100 terminal streams at once did not establish a
stable 100-stream cohort: 96 connections ended by the end of one observation,
and 82 ended in a separate fresh burst. No cgroup OOM occurred. The SSE bodies did
not give a close reason, so these observations are not attributed to a specific
authorization error. They are not steady-state cost measurements for 100 streams.
At 1 and 10 streams, none ended in their observation windows. The successful
minimum-host workload does not promise capacity for 100 simultaneous viewers.

An earlier trial accidentally retained a client idle deadline; its 100-stream
lifetime result is excluded. The results above use the corrected client and retain
per-connection close state. No polling interval, lookup deadline, revocation rule,
terminal-run behaviour or production stream code was changed for this finding.
The J1 evidence archive retains the raw statement snapshots, CPU counters, Docker
samples, OOM events, stream states and reproducible measurement scripts.
