export function sizeBalancedBatches<Value>(
  values: readonly Value[],
  workerCount: number,
  weight: (value: Value) => number,
): readonly (readonly { readonly index: number; readonly value: Value }[])[] {
  const batches = Array.from(
    { length: Math.min(workerCount, values.length) },
    () => ({ weight: 0, entries: [] as { index: number; value: Value }[] }),
  );
  const largestFirst = values
    .map((value, index) => ({ index, value }))
    .sort((left, right) => weight(right.value) - weight(left.value) || left.index - right.index);
  for (const entry of largestFirst) {
    let target = batches[0]!;
    for (const candidate of batches) {
      if (candidate.weight < target.weight) target = candidate;
    }
    target.entries.push(entry);
    target.weight += weight(entry.value);
  }
  return batches.map((batch) => batch.entries);
}
