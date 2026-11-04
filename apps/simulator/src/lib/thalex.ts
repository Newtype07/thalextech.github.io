import {
  fetchInstruments as fetchInstrumentsRaw,
  fetchLatestIndexPrice as fetchLatestIndexPriceRaw,
  fetchLatestMarkPrice as fetchLatestMarkPriceRaw,
} from "../../../../lib/thalex.js";

import type { ThalexInstrument } from "../../../../lib/thalex-instrument.ts";
export type { ThalexInstrument } from "../../../../lib/thalex-instrument.ts";

export type IndexPriceRow = {
  ts: number;
  index_price_open: number;
  index_price_high: number;
  index_price_low: number;
  index_price_close: number;
};

export type MarkPriceRow = {
  ts: number;
  mark_price_open: number;
  mark_price_high: number;
  mark_price_low: number;
  mark_price_close: number;
  iv_open?: number | null;
  iv_high?: number | null;
  iv_low?: number | null;
  iv_close?: number | null;
  funding?: number | null;
  tob?: number | null;
};

export const fetchInstruments = fetchInstrumentsRaw as () => Promise<ThalexInstrument[]>;
export const fetchLatestIndexPrice = fetchLatestIndexPriceRaw as (
  index_name: string,
  resolution?: string,
) => Promise<IndexPriceRow | null>;
export const fetchLatestMarkPrice = fetchLatestMarkPriceRaw as (
  instrument_name: string,
  resolution?: string,
) => Promise<MarkPriceRow | null>;
