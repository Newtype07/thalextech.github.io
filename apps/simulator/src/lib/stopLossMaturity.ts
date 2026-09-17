import type { AtmOptionExpiryQuote } from "./atmOptionChain";

const SECONDS_PER_DAY = 24 * 60 * 60;
const expiryDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export type StopLossDirection = "up" | "down";

export type MaturityOption = {
  label: string;
  value: number;
};

export const displayedDaysToExpiry = (
  expirationTs: number,
  valuationTs: number,
): number =>
  Math.max(1, Math.ceil((expirationTs - valuationTs) / SECONDS_PER_DAY));

export const selectableExpiryQuotes = (
  expiryQuotes: AtmOptionExpiryQuote[],
  valuationTs: number,
  horizonDays: number,
  direction: StopLossDirection,
): AtmOptionExpiryQuote[] => {
  return expiryQuotes
    .filter(
      (quote) =>
        displayedDaysToExpiry(quote.expirationTs, valuationTs) >= horizonDays &&
        (direction === "up" || quote.putInstrumentName != null),
    )
    .sort((first, second) => first.expirationTs - second.expirationTs);
};

export const maturityOptionsForQuotes = (
  quotes: AtmOptionExpiryQuote[],
  valuationTs: number,
): MaturityOption[] =>
  quotes.map((quote) => ({
    label: `${displayedDaysToExpiry(quote.expirationTs, valuationTs)}d [${expiryDateFormatter.format(new Date(quote.expirationTs * 1000))}]`,
    value: quote.expirationTs,
  }));

export const horizonOptionsForQuotes = (
  quotes: AtmOptionExpiryQuote[],
  valuationTs: number,
  defaultDays: readonly number[],
): MaturityOption[] =>
  [...new Set([
    ...defaultDays,
    ...quotes.map((quote) =>
      displayedDaysToExpiry(quote.expirationTs, valuationTs),
    ),
  ])]
    .filter((days) => Number.isFinite(days) && days > 0)
    .sort((first, second) => first - second)
    .map((days) => ({ label: `${days}d`, value: days }));

export const resolveHorizonSeconds = (
  horizonDays: number,
  selectedExpirationTs: number,
  valuationTs: number,
): number => {
  const requestedSeconds = Math.max(0, horizonDays) * SECONDS_PER_DAY;
  const selectedSeconds = selectedExpirationTs - valuationTs;
  return selectedSeconds > 0
    ? Math.min(requestedSeconds, selectedSeconds)
    : requestedSeconds;
};

export const closestExpirationTs = (
  quotes: AtmOptionExpiryQuote[],
  targetExpirationTs: number,
): number | null => {
  if (!quotes.length) return null;
  return quotes.reduce((closest, quote) =>
    Math.abs(quote.expirationTs - targetExpirationTs) <
    Math.abs(closest.expirationTs - targetExpirationTs)
      ? quote
      : closest,
  ).expirationTs;
};
