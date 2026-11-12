import test from 'node:test';
import assert from 'node:assert/strict';
import { rankOptions, optionSide, historicalFrequency, verdict, aggregateCandles } from './target-trade.js';
const rankCalls = (calls, target) => rankOptions(calls.map(call => ({...call, side:'call'})), target, 1);
const candles=prices=>prices.map((p,i)=>[i*3600,p,p,p,p]);
test('selects maximum gross payout, not maximum payout or nearest strike',()=>{
 const ranked=rankCalls([{strike:80,premium:10},{strike:90,premium:2},{strike:99,premium:0.4}],100);
 assert.equal(ranked[0].strike,90);assert.equal(ranked[0].multiple,5);assert.equal(ranked[0].required,.2);
});
test('rejects invalid asks, worthless calls and invalid targets',()=>{
 assert.equal(rankCalls([{strike:90,premium:0},{strike:90,premium:null},{strike:100,premium:1},{strike:110,premium:1},{strike:90,premium:-2}],100).length,0);
 assert.deepEqual(rankCalls([{strike:90,premium:1}],NaN),[]);
});
test('uses terminal directional returns, includes equality, and rounds horizon',()=>{
 const h=historicalFrequency(candles([100,110,99,120]),.1,3700);
 assert.equal(h.hits,2);assert.equal(h.total,3);assert.equal(h.hours,1);
 assert.equal(historicalFrequency(candles([100,90,99]),-.1,3600).hits,1);
 assert.equal(historicalFrequency(candles([100,120,100]),.1,7200).hits,0);
});
test('missing hours invalidate windows rather than shortening the horizon',()=>{
 const rows=candles([100,110,120,130]);rows.splice(1,1);
 assert.equal(historicalFrequency(rows,.1,7200).total,0);
 assert.equal(historicalFrequency(rows,.01,3600).total,1);
});
test('no samples is unavailable, ties pass, required rate above 100% passes',()=>{
 assert.equal(verdict({required:.2},{frequency:.2}),'PASS');
 assert.equal(verdict({required:.2},{frequency:.21}),'BUY');
 assert.equal(verdict({required:2},{frequency:1}),'PASS');
 assert.equal(verdict(null,{frequency:1}),'UNAVAILABLE');
 assert.equal(verdict({required:.2},historicalFrequency(candles([100]),.1,3600)),'UNAVAILABLE');
 assert.equal(historicalFrequency([],0,-1),null);
});
test('aggregates real daily OHLC without changing hourly inputs',()=>{
 const rows=[[0,10,14,9,12],[3600,12,16,11,15],[86400,15,20,14,19]];
 assert.deepEqual(aggregateCandles(rows),[[0,10,16,9,15],[86400,15,20,14,19]]);
 assert.equal(rows[0][4],12);
});
test('four-hour candles preserve OHLC and separate adjacent buckets', () => {
  const rows = [[0,100,110,90,105],[3600,105,120,99,115],[10800,115,125,101,102],[14400,102,109,98,108]];
  assert.deepEqual(aggregateCandles(rows, 4*3600), [[0,100,125,90,102],[14400,102,109,98,108]]);
});
test('weekly candles start on Monday UTC across the Sunday boundary', () => {
  const sunday = Date.parse('2026-11-08T23:00:00Z')/1000;
  const monday = sunday + 3600;
  const result = aggregateCandles([[sunday,100,105,95,102],[monday,102,110,99,108]], 7*86400, 4*86400);
  assert.equal(new Date(result[0][0]*1000).toISOString(), '2026-11-02T00:00:00.000Z');
  assert.equal(result[1][0], monday);
  assert.equal(result.length, 2);
});

test('switches sides strictly below spot and ranks puts by strike minus target', () => {
  const options = [
    {side:'call',strike:70,premium:1},
    {side:'put',strike:100,premium:10},
    {side:'put',strike:90,premium:2},
    {side:'put',strike:80,premium:1},
    {side:'put',strike:110,premium:0},
  ];
  const ranked = rankOptions(options, 80, 100);
  assert.equal(optionSide(80,100), 'put');
  assert.equal(optionSide(100,100), 'call');
  assert.equal(optionSide(101,100), 'call');
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].strike, 90);
  assert.equal(ranked[0].payout, 10);
  assert.equal(ranked[0].multiple, 5);
  assert.equal(ranked[0].required, .2);
  assert.ok(ranked.every(option => option.side === 'put'));
  assert.deepEqual(rankOptions(options, 80, NaN), []);
});
test('touch counts intrahorizon highs and lows even when the terminal close misses', () => {
  const up = [[0,100,150,90,100],[3600,100,115,98,101],[7200,101,105,99,100]];
  const h = historicalFrequency(up,.1,7200);
  assert.equal(h.total,1);
  assert.equal(h.hits,0);
  assert.equal(h.touchHits,1);
  assert.equal(h.touchFrequency,1);
  const down = [[0,100,110,50,100],[3600,100,102,85,99],[7200,99,101,95,100]];
  assert.equal(historicalFrequency(down,-.1,7200).touchHits,1);
});
test('touch excludes pre-entry highs/lows and windows with missing hours', () => {
  const rows = [[0,100,150,50,100],[3600,100,105,95,100],[7200,100,105,95,100]];
  assert.equal(historicalFrequency(rows,.1,7200).touchHits,0);
  assert.equal(historicalFrequency(rows,-.1,7200).touchHits,0);
  assert.equal(historicalFrequency([rows[0],rows[2]],.1,7200).touchFrequency,null);
  assert.equal(historicalFrequency(rows,0,7200).touchFrequency,1);
  assert.equal(historicalFrequency([rows[0]],.1,7200).touchFrequency,null);
});
