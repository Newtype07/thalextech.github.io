const SECONDS_PER_BS_YEAR = 365.25 * 24 * 60 * 60;

const normalCdf = (x) => {
  if (x === 0) return 0.5;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * absX);
  const tau =
    t *
    Math.exp(
      -absX * absX -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277)))))))),
    );
  // Evaluate the small tail directly to avoid cancellation for rare wins.
  return x < 0 ? 0.5 * tau : 1 - 0.5 * tau;
};

export const calcOptionNd2 = ({ optionType, spot, strike, iv, tauSeconds }) => {
  if (!Number.isFinite(spot) || spot <= 0) return null;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  if (!Number.isFinite(iv) || iv <= 0) return null;
  if (!Number.isFinite(tauSeconds)) return null;
  if (tauSeconds <= 0) {
    const above = spot > strike ? 1 : spot < strike ? 0 : 0.5;
    return optionType === "put" ? 1 - above : above;
  }
  const tau = tauSeconds / SECONDS_PER_BS_YEAR;
  if (!Number.isFinite(tau) || tau <= 0) return null;
  const sqrtTau = Math.sqrt(tau);
  const d2 = (Math.log(spot / strike) - 0.5 * iv * iv * tau) / (iv * sqrtTau);
  if (!Number.isFinite(d2)) return null;
  return normalCdf(optionType === "put" ? -d2 : d2);
};

// Same zero-rate, zero-carry lognormal model as P(win). Truncate at strike so
// the partial-payoff region between strike and break-even is included; a mean
// conditional on break-even is biased high for calls and low for puts because
// it ignores finishes that pay out less than the premium.
export const calcConditionalWinningPrice = ({ optionType, spot, strike, iv, tauSeconds }) => {
  const probability = calcOptionNd2({ optionType, spot, strike, iv, tauSeconds });
  if (!(probability > 0)) return null;
  if (tauSeconds <= 0) {
    const itm = optionType === "put" ? spot < strike : spot > strike;
    return itm ? spot : null;
  }

  const variance = iv * iv * tauSeconds / SECONDS_PER_BS_YEAR;
  const standardDeviation = Math.sqrt(variance);
  const d1 = (Math.log(spot / strike) + 0.5 * variance) / standardDeviation;
  const inTheMoneyMoment = spot * normalCdf(optionType === "put" ? -d1 : d1);
  const mean = inTheMoneyMoment / probability;
  return Number.isFinite(mean) && mean > 0 ? mean : null;
};

// Vertical spread: long the strike closer to the money, short the farther strike.
// For a call spread (longStrike < shortStrike) the payoff caps at shortStrike;
// for a put spread (longStrike > shortStrike) it caps at shortStrike from below.
// AWP conditions on positive payoff (S past longStrike) and treats the terminal
// price as capped at shortStrike, matching how far upside/downside is useful.
export const calcConditionalSpreadWinningPrice = ({ optionType, spot, longStrike, shortStrike, iv, tauSeconds }) => {
  if (!Number.isFinite(spot) || spot <= 0) return null;
  if (!Number.isFinite(longStrike) || longStrike <= 0) return null;
  if (!Number.isFinite(shortStrike) || shortStrike <= 0) return null;
  if (!Number.isFinite(iv) || iv <= 0) return null;
  if (!Number.isFinite(tauSeconds)) return null;
  const isPut = optionType === "put";
  if (isPut ? shortStrike >= longStrike : shortStrike <= longStrike) return null;
  if (tauSeconds <= 0) {
    const itm = isPut ? spot < longStrike : spot > longStrike;
    if (!itm) return null;
    return isPut ? Math.max(spot, shortStrike) : Math.min(spot, shortStrike);
  }

  const variance = iv * iv * tauSeconds / SECONDS_PER_BS_YEAR;
  const sd = Math.sqrt(variance);
  const d1Long = (Math.log(spot / longStrike) + 0.5 * variance) / sd;
  const d1Short = (Math.log(spot / shortStrike) + 0.5 * variance) / sd;
  const d2Long = d1Long - sd;
  const d2Short = d1Short - sd;
  const sign = isPut ? -1 : 1;
  const probability = normalCdf(sign * d2Long);
  if (!(probability > 0)) return null;
  // E[S · 1_{S between legs}] + shortStrike · P(S past shortStrike)
  const moment =
    spot * (normalCdf(sign * d1Long) - normalCdf(sign * d1Short)) +
    shortStrike * normalCdf(sign * d2Short);
  const mean = moment / probability;
  return Number.isFinite(mean) && mean > 0 ? mean : null;
};
