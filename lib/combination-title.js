const strikeFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const maturityFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
});
const formatMaturity = (ts) => maturityFormatter.format(new Date(ts * 1000));

// The on-screen heading and exported chart describe the same net combination.
export function formatCombinationTitle(legs, asset) {
  const groups = new Map();
  for (const leg of legs) {
    const key = `${leg.expirationTs}:${leg.strike}:${leg.optionType}`;
    const group = groups.get(key) ?? { ...leg, signedQty: 0 };
    group.signedQty += leg.signedQty;
    groups.set(key, group);
  }
  const sorted = [...groups.values()]
    .filter((leg) => leg.signedQty !== 0)
    .sort((a, b) => a.expirationTs - b.expirationTs || a.strike - b.strike
      || a.optionType.localeCompare(b.optionType));
  if (!sorted.length) return asset;
  const sharedMaturity = sorted.every((leg) => leg.expirationTs === sorted[0].expirationTs);
  const parts = sorted.map((leg) => {
    const sign = leg.signedQty < 0 ? "−" : "";
    const maturity = sharedMaturity ? "" : `${formatMaturity(leg.expirationTs)} `;
    return `${sign}${Math.abs(leg.signedQty)} × ${maturity}${strikeFormatter.format(leg.strike / 1000)}K ${leg.optionType === "put" ? "Put" : "Call"}`;
  });
  return [asset, ...(sharedMaturity ? [formatMaturity(sorted[0].expirationTs)] : []), parts.join("\u2002")].join(" · ");
}
