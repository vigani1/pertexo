/** Longest first, placing each file on the least loaded shard. */
export function assignDurationShards(files, durations, count) {
  const recorded = Object.values(durations).sort((a, b) => a - b);
  const middle = Math.floor(recorded.length / 2);
  const median =
    recorded.length === 0
      ? 0
      : recorded.length % 2
        ? recorded[middle]
        : (recorded[middle - 1] + recorded[middle]) / 2;
  const duration = (file) => durations[file] ?? median;
  const shards = Array.from({ length: count }, () => ({
    files: [],
    milliseconds: 0,
  }));
  for (const file of [...files].sort(
    (a, b) => duration(b) - duration(a) || a.localeCompare(b),
  )) {
    const shard = shards.reduce((least, next) =>
      next.milliseconds < least.milliseconds ? next : least,
    );
    shard.files.push(file);
    shard.milliseconds += duration(file);
  }
  return shards;
}
