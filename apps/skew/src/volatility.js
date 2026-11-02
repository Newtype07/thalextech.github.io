// Decimal IV, seconds, and C/P option sides.
function normalCdf(x) {
  const z = Math.abs(x),
    t = 1 / (1 + 0.2316419 * z);
  const p =
    1 -
    (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) *
      t *
      (0.31938153 +
        t *
          (-0.356563782 +
            t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? p : 1 - p;
}

export function spotDelta({ strike, iv, spot, expiry, ts, side }) {
  const years = (expiry - ts) / (365.25 * 86400);
  if (!(years > 0 && iv > 0 && spot > 0 && strike > 0)) return NaN;
  const d1 =
    (Math.log(spot / strike) + (iv * iv * years) / 2) / (iv * Math.sqrt(years));
  return normalCdf(d1) - (side === "P" ? 1 : 0);
}

