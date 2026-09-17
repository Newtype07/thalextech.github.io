export type AtmOptionExpiryQuote = {
  expirationTs: number;
  strike: number;
  callStrikes?: number[];
  putStrikes?: number[];
  callInstrumentName: string;
  putInstrumentName: string | null;
  callIv: number | null;
  putIv: number | null;
  callMark: number | null;
  putMark: number | null;
  fetchedAt: number | null;
};
