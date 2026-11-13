import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPremiums } from './market-data.js';
import { streamQuoteSnapshot } from './quote-snapshot.js';
const options = ['C80','C85','P80'].map(name => ({name:`BTC-${name}`, expiry:1, strike:80, side:name[0]==='C'?'call':'put'}));
const row = (bid=[9,2], ask=[10,3], time=Date.now()/1000) => [time,10,80,80,.5,bid,ask];
class Socket extends EventTarget {
  static send = () => {};
  static last;
  constructor() { super(); Socket.last=this; queueMicrotask(()=>this.dispatchEvent(new Event('open'))); }
  send(text) { this.request=JSON.parse(text); Socket.send(this); }
  emit(tickers) { this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({channel_name:'lwt_options.BTCUSD.all.1000ms',notification:{tickers}})})); }
  close() { this.closed=true; }
}
const transport = {WebSocketImpl:Socket,url:'wss://example.test',dispatch:async(signal,send)=>{signal.throwIfAborted();send();}};
const signal = () => new AbortController().signal;
test('a batched snapshot prices the entire expiry without per-instrument REST calls', async () => {
  Socket.send = socket => {
    socket.emit({[options[0].name]:row()});
    queueMicrotask(()=>socket.emit({[options[1].name]:row(),[options[2].name]:row()}));
  };
  const progress=[];
  const result=await loadPremiums(options,signal(),done=>progress.push(done),{
    ...transport, requestImpl:()=>assert.fail('complete stream must not request individual tickers'),
  });
  assert.equal(result.quotes.length,3);
  assert.equal(result.excluded,0);
  assert.equal(result.quotes[0].amount,3);
  assert.equal(result.quotes[0].bidAmount,2);
  assert.deepEqual(progress,[1,3]);
  assert.equal(Socket.last.closed,true);
  assert.equal(Socket.last.request.method,'public/subscribe');
});
test('known stale, malformed and empty quotes stay excluded without REST retries', async () => {
  Socket.send=socket=>socket.emit({[options[0].name]:row([],[],Date.now()/1000-300),[options[1].name]:null,[options[2].name]:row([],[])});
  const result=await loadPremiums(options,signal(),undefined,{...transport,requestImpl:()=>assert.fail('known unavailable quotes must not fan out')});
  assert.deepEqual(result,{quotes:[],excluded:3});
});
test('partial streams retain bid-only quotes and REST fills only missing instruments', async () => {
  Socket.send=socket=>{socket.emit({[options[0].name]:row([9,2],[])});socket.dispatchEvent(new Event('close'));};
  const names=[];
  const result=await loadPremiums(options,signal(),undefined,{...transport,requestImpl:async(path,params)=>{
    names.push(params.instrument_name);
    return {mark_timestamp:Date.now()/1000,best_ask_price:10,best_ask_amount:1};
  }});
  assert.deepEqual(names,options.slice(1).map(option=>option.name));
  assert.equal(result.quotes.length,3);
  assert.equal(result.quotes[0].amount,0);
  assert.equal(result.quotes[0].bidAmount,2);
});
test('a stalled stream times out and closes before REST fallback', async () => {
  Socket.send=()=>{};
  const result=await loadPremiums(options,signal(),undefined,{...transport,timeoutMs:1,requestImpl:async()=>{
    assert.equal(Socket.last.closed,true);
    return {mark_timestamp:Date.now()/1000,best_ask_price:10,best_ask_amount:1};
  }});
  assert.equal(result.quotes.length,3);
});
test('cancellation closes the socket and prevents REST fallback', async () => {
  Socket.send=()=>{};
  const controller=new AbortController();
  const result=loadPremiums(options,controller.signal,undefined,{...transport,requestImpl:()=>assert.fail('aborted load cannot fetch')});
  controller.abort();
  await assert.rejects(result,{name:'AbortError'});
  assert.equal(Socket.last.closed,true);
});
test('without WebSocket support, REST remains available', async () => {
  assert.deepEqual(await streamQuoteSnapshot(options,signal(),undefined,{WebSocketImpl:null}),{quotes:[],received:new Set()});
});

const ladder = [60,70,80,90,100,110,120].flatMap(strike => ['call','put'].map(side => ({
  name:`BTC-${strike}-${side}`,strike,side,expiry:1,
})));
const directQuote = () => ({mark_timestamp:Date.now()/1000,best_bid_price:9,best_bid_amount:2,best_ask_price:10,best_ask_amount:3});
const settle = async () => { for(let i=0;i<20;i++) await Promise.resolve(); };
test('near-spot calls and puts publish before requesting the remaining expiry', async () => {
  let finishWings;
  const sent=[], updates=[];
  Socket.send = socket => {
    sent.push(socket.request.params.channels);
    if (sent.length === 1) {
      for (const channel of socket.request.params.channels) socket.dispatchEvent(new MessageEvent('message',{
        data:JSON.stringify({channel_name:channel,notification:directQuote()}),
      }));
    } else finishWings=()=>socket.emit(Object.fromEntries(ladder.map(option=>[option.name,row()])));
  };
  const loading=loadPremiums(ladder,signal(),undefined,{...transport,spot:95,onQuotes:update=>updates.push(update),requestImpl:()=>assert.fail('stream is complete')});
  await settle();
  assert.equal(sent[0].length,8,'two strike levels on each side of spot, both calls and puts');
  assert.ok(sent[0].every(channel=>/^ticker\.BTC-(80|90|100|110)-(call|put)\.1000ms$/.test(channel)));
  assert.deepEqual(sent[1],['lwt_options.BTCUSD.all.1000ms']);
  assert.equal(updates[0].loaded,8);
  assert.equal(updates[0].quotes.length,8);
  assert.equal(updates[0].total,14);
  finishWings();
  assert.equal((await loading).quotes.length,14);
  assert.equal(updates.at(-1).loaded,14);
});
test('REST fallback prioritizes ATM strikes and publishes them while wings remain pending', async () => {
  const requested=[], updates=[];
  let releaseWings;
  const wings=new Promise(resolve=>releaseWings=resolve);
  const loading=loadPremiums(ladder,signal(),undefined,{WebSocketImpl:null,spot:95,onQuotes:update=>updates.push(update),requestImpl:async(path,params)=>{
    requested.push(params.instrument_name);
    if (!/BTC-(80|90|100|110)-/.test(params.instrument_name)) await wings;
    return directQuote();
  }});
  await settle();
  assert.ok(requested.slice(0,8).every(name=>/BTC-(80|90|100|110)-/.test(name)));
  assert.equal(updates[0].loaded,8);
  assert.equal(updates[0].quotes.length,8);
  releaseWings();
  assert.equal((await loading).quotes.length,14);
});
test('cancelling after ATM readiness prevents late wing quotes from publishing', async () => {
  const controller=new AbortController(), updates=[];
  Socket.send=socket=>{
    for (const channel of socket.request.params.channels.filter(name=>name.startsWith('ticker.')))
      socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({channel_name:channel,notification:directQuote()})}));
  };
  const loading=loadPremiums(ladder,controller.signal,undefined,{...transport,spot:95,onQuotes:update=>updates.push(update),requestImpl:()=>assert.fail('cancelled load cannot fall back')});
  await settle();
  assert.equal(updates.length,1);
  controller.abort();
  await assert.rejects(loading,{name:'AbortError'});
  Socket.last.emit(Object.fromEntries(ladder.map(option=>[option.name,row()])));
  assert.equal(updates.length,1);
  assert.equal(Socket.last.closed,true);
});
