// Decimal IV, seconds, and C/P option sides.
export function selectLiveQuotes(quotes, source = "mark") {
  return source === "mark"
    ? quotes
    : quotes.map((q) => ({
        ...q,
        iv: q.bookIv > 0 && Number.isFinite(q.bookIv) ? q.bookIv : q.iv,
      }));
}

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

// Undiscounted Black forward price, using the live ticker's expiry forward.
export function bookMidIv({ bid, ask, forward, strike, expiry, ts, side }) {
  if (
    ![bid, ask, forward, strike, expiry, ts].every(Number.isFinite) ||
    bid < 0 ||
    ask <= 0 ||
    ask < bid ||
    forward <= 0 ||
    strike <= 0 ||
    expiry <= ts
  )
    return null;
  const price = (bid + ask) / 2,
    years = (expiry - ts) / (365.25 * 86400);
  const intrinsic = Math.max(
    side === "C" ? forward - strike : strike - forward,
    0,
  );
  if (price <= intrinsic || price >= (side === "C" ? forward : strike))
    return null;
  const optionPrice = (iv) => {
    const volTime = iv * Math.sqrt(years);
    const d1 = Math.log(forward / strike) / volTime + volTime / 2,
      d2 = d1 - volTime;
    return side === "C"
      ? forward * normalCdf(d1) - strike * normalCdf(d2)
      : strike * normalCdf(-d2) - forward * normalCdf(-d1);
  };
  let low = 0.000001,
    high = 1;
  while (optionPrice(high) < price && high < 64) high *= 2;
  if (optionPrice(high) < price) return null;
  for (let i = 0; i < 64; i++) {
    const mid = (low + high) / 2;
    if (optionPrice(mid) < price) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

