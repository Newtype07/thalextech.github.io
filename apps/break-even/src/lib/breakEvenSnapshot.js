const SECONDS_PER_BS_YEAR = 365.25 * 24 * 60 * 60;

const erfApprox = (x) => {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
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
  return sign * (1 - tau);
};

const normalCdf = (x) => 0.5 * (1 + erfApprox(x / Math.SQRT2));

const calcNd2 = ({ spot, strike, iv, tauSeconds }) => {
  if (!Number.isFinite(spot) || spot <= 0) return null;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  if (!Number.isFinite(iv) || iv <= 0) return null;
  if (!Number.isFinite(tauSeconds)) return null;
  if (tauSeconds <= 0) {
    if (spot > strike) return 1;
    if (spot < strike) return 0;
    return 0.5;
  }
  const tau = tauSeconds / SECONDS_PER_BS_YEAR;
  if (!Number.isFinite(tau) || tau <= 0) return null;
  const sqrtTau = Math.sqrt(tau);
  const d2 = (Math.log(spot / strike) - 0.5 * iv * iv * tau) / (iv * sqrtTau);
  if (!Number.isFinite(d2)) return null;
  return normalCdf(d2);
};

export const calcOptionNd2 = ({ optionType, spot, strike, iv, tauSeconds }) => {
  const callNd2 = calcNd2({ spot, strike, iv, tauSeconds });
  if (!Number.isFinite(callNd2)) return null;
  return optionType === "put" ? 1 - callNd2 : callNd2;
};
