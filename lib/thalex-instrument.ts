export type ThalexInstrument = {
  instrument_name: string;
  index_name?: string;
  option_type?: string;
  strike_price?: number;
  expiration_timestamp?: number;
  create_time?: number | string;
  create_time_ms?: number | string;
  kind?: string;
  type?: string;
  underlying?: string;
};
