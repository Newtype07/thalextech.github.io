import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePriceHistory } from './price-history.js';
import { aggregateCandles, historicalFrequency } from './target-trade.js';
import { loadHourlyTail } from './market-data.js';

test('fills the archive tail and aligns the active close to spot without sampling the partial hour', () => {
  const archive = [[0,100,105,95,102]];
  const hourly = [[0,100,106,95,103],[3600,103,110,102,109]];
  const minutes = [[7200,109,112,108,111],[7260,111,113,110,112]];
  const result = mergePriceHistory(archive, hourly, minutes, 107, 7350);
  assert.deepEqual(result.completed, [[0,100,106,95,103],[3600,103,110,102,109]]);
  assert.deepEqual(result.active, [7200,109,113,107,107]);
  assert.equal(aggregateCandles([...result.completed,result.active]).at(-1)[4],107);
  assert.equal(historicalFrequency(result.completed, .01, 3600).total,1);
  assert.equal(archive[0][4],102,'does not mutate the source archive');
});
test('does not invent missing hours or include future minute observations', () => {
  const result = mergePriceHistory([[0,100,105,95,102]],
    [[7200,100,105,95,102]], [[10800,102,104,101,103],[10860,103,200,100,190]],103,10890);
  assert.deepEqual(result.completed.map(row=>row[0]),[0,7200]);
  assert.deepEqual(result.active,[10800,102,104,101,103]);
  assert.equal(historicalFrequency(result.completed,0,3600).total,0);
});
test('the first observation at an hour boundary is an active snapshot, never a completed candle', () => {
  const result=mergePriceHistory([],[],[],123,7201);
  assert.deepEqual(result.completed,[]);
  assert.deepEqual(result.active,[7200,123,123,123,123]);
});
test('pages truncated live history back to the archive boundary', async () => {
  const pages = [[[7200,100,105,95,102],[10800,102,106,101,105]],
    [[0,98,101,97,100],[3600,100,103,99,102]]];
  const requests=[];
  const rows=await loadHourlyTail(0,14399,new AbortController().signal,async (path,params)=>{
    requests.push(params); return {index:pages.shift()};
  });
  assert.equal(requests[1].to,7199);
  assert.deepEqual(rows.map(row=>row[0]),[0,3600,7200,10800]);
});
