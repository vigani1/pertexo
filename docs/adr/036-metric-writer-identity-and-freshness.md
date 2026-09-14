# ADR 036: Privacy-safe metric writer identity and source freshness

- **Status:** accepted
- **Date:** 2026-09-13

## Context

Pertexo exports cumulative OpenTelemetry counters, gauges and histograms from
independently running API, worker and maintenance processes. The local
collector previously deleted `service.instance.id` before exposing metrics to
Prometheus. Writers with the same service, environment, version and instrument
labels therefore collapsed onto one Prometheus series even though their
cumulative streams had independent start times and resets. Downstream `sum`,
`max` and histogram aggregation cannot repair that loss of writer identity.

Two alerts also depended on properties the exported series did not establish.
The worker-start counter remained at one in each process and commonly vanished
before its first 60-second periodic export during a rapid crash. The regional
replica alert treated a fresh scrape of the collector's cached last value as a
fresh observation by the maintenance process.

Hostnames, process IDs, command lines, tenant identifiers and arbitrary
deployment labels are not acceptable metric dimensions. The existing restart
threshold and regional recovery-point policy must remain unchanged.

## Decision

Every telemetry SDK instance creates one opaque random UUID as its standard
`service.instance.id`. The collector retains that single writer dimension while
continuing to delete host, process and command resource attributes. The value
contains no customer, host, task, region or process data. Operational queries
aggregate across it explicitly; it is not a product or tenant label.
The collector expires a writer series after 20 minutes without a new OTLP
datapoint, retaining the full 15-minute restart window while bounding obsolete
writer cardinality independently of customer traffic.

Worker startup is represented by a per-writer gauge containing the Unix start
time. Immediately after recording it, worker composition asks the metric reader
to flush. Startup remains successful if metric recording or flushing fails, but
the failure is diagnosed. The restart alert counts distinct writer series whose
reported start time is within the existing 15-minute window and retains the
existing `> 5` threshold. An old running process therefore ages out, while a
short-lived process that completes the bounded flush remains observable.

The regional-replica emitter records an originating observation timestamp
beside admission and lag gauges, without state-changing labels that could leave
obsolete gauge series behind. Admission and lag select the writer with the
newest source timestamp. Freshness is evaluated from that timestamp, not
collector scrape presence. Ninety seconds is the tested maximum freshness
age: the 60-second SDK export cadence, five-second collector batch timeout and
15-second Prometheus scrape interval total 80 seconds, leaving ten seconds for
scheduling jitter. The existing one-minute alert `for` duration remains. The
five-minute replay-lag boundary is unchanged.

## Consequences

Multi-process cumulative streams remain distinguishable through resets and can
be summed or maximized without silently replacing another writer. Histogram
buckets retain a valid writer dimension until query-time aggregation. A bounded
amount of additional Prometheus cardinality is introduced per live or recently
observed process; retention and process counts, rather than customer activity,
bound it.

The immediate startup flush adds one bounded telemetry request during worker
composition. It does not make telemetry a readiness dependency. Collector or
network failure can still lose a rapid-crash observation, so deployed restart
qualification must correlate the metric with the external workload supervisor;
local rule and pipeline tests do not claim pager delivery or ECS event capture.

Cached regional values can remain scrapeable indefinitely without appearing
fresh. A stopped producer crosses the source-age bound even while the collector
and Prometheus remain healthy.

## Rejected alternatives

Deleting writer identity and summing downstream was rejected because independent
cumulative streams can collide before the query sees them. Exporting hostnames,
PIDs, task ARNs or tenant-derived labels was rejected for privacy and cardinality
reasons. Treating `increase(counter[15m])` as a process-start count was rejected
because an initial cumulative sample is not an increase and rapid exits can
precede periodic export. Scrape absence was rejected as a source-freshness proxy
because the collector caches the last exported gauge.
