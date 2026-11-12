import fs from 'node:fs/promises';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
const source = new URL('../../backtest/source-data/thalex/', import.meta.url);
const files = (await fs.readdir(source)).filter(n => /^BTCUSD_index_1h_\d{6}\.parquet$/.test(n)).sort();
if (!files.length) throw new Error('BTC hourly source history is missing.');
const rows = new Map();
for (const file of files) {
  const decoded = await parquetReadObjects({ file: await asyncBufferFromFile(new URL(file, source).pathname), compressors,
    columns: ['ts', 'index_price_open', 'index_price_high', 'index_price_low', 'index_price_close'] });
  for (const r of decoded) {
    const row = [r.ts, r.index_price_open, r.index_price_high, r.index_price_low, r.index_price_close].map(Number);
    if (row.every(Number.isFinite) && row.slice(1).every(v => v > 0) && row[0] + 3600 <= Date.now()/1000) rows.set(row[0], row);
  }
}
const candles = [...rows.values()].sort((a,b)=>a[0]-b[0]);
if (!candles.length) throw new Error('No valid BTC history.');
const out = new URL('../public/history/', import.meta.url);
await fs.mkdir(out, { recursive: true });
await fs.writeFile(new URL('btc.json', out), JSON.stringify({ source: 'Tracked Thalex BTCUSD hourly index Parquet', candles }));
console.log(`Prepared ${candles.length} observed BTC hourly candles.`);
