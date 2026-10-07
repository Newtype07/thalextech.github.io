// Find the closest ordered baselines with enough room for each label. Pooling
// crowded neighbors shares the movement instead of pushing every label down.
export function priceLabelPositions(targets, minY, maxY, minSpacing = 16) {
  const sorted = targets.map((target, index) => ({ target, index }))
    .sort((a, b) => a.target - b.target);
  const spacing = Math.min(minSpacing, (maxY - minY) / Math.max(1, sorted.length - 1));
  const groups = [];
  for (const [row, label] of sorted.entries()) {
    groups.push({ sum: label.target - row * spacing, labels: [label] });
    while (groups.length > 1) {
      const current = groups.at(-1);
      const previous = groups.at(-2);
      if (previous.sum / previous.labels.length <= current.sum / current.labels.length) break;
      groups.pop();
      previous.sum += current.sum;
      previous.labels.push(...current.labels);
    }
  }
  const positions = [];
  const maxBase = maxY - spacing * (sorted.length - 1);
  let row = 0;
  for (const group of groups) {
    const base = Math.max(minY, Math.min(maxBase, group.sum / group.labels.length));
    for (const label of group.labels) positions[label.index] = base + row++ * spacing;
  }
  return positions;
}
