import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import { Window } from 'happy-dom';

// Exercise the real app's expiry selection, timer, quote replacement and chart
// input together. Only the public market adapter and history transport are faked.
test('automatic refresh keeps fresh trades visible and dragging works while quotes reload', async t => {
  const directory = await mkdtemp(fileURLToPath(new URL('../.refresh-test-', import.meta.url)));
  const window = new Window({ url: 'http://localhost/' });
  const names = ['window','document','Node','Element','HTMLElement','SVGElement'];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] });
  let app;
  try {
    const now = Date.parse('2026-11-11T18:00:00Z');
    t.mock.timers.enable({ apis: ['Date','setInterval'], now });
    const adapter = resolve(directory, 'market.mjs');
    await writeFile(adapter, `
      const expiry = ${now/1000} + 7*86400;
      export const state = { requests: 0, hold: false, empty: false, release: null };
      const options = [{ name: 'BTC-C80', side: 'call', strike: 80000, expiry }, { name: 'BTC-C85', side: 'call', strike: 85000, expiry }, { name: 'BTC-P80', side: 'put', strike: 80000, expiry }, { name: 'BTC-P75', side: 'put', strike: 75000, expiry }];
      export async function loadMarket() { state.requests++; return { spot: 80000, options }; }
      export async function loadPremiums() {
        if (state.hold) await new Promise(resolve => state.release = resolve);
        if (state.empty) return { quotes: [], excluded: options.length };
        return { quotes: options.map((option, i) => ({ ...option, premium: [1000,400,1000,200][i],
          amount: 1, ts: Date.now()/1000 })), excluded: 0 };
      }
    `);
    const compiled = new Map();
    async function compile(filename) {
      if (compiled.has(filename)) return compiled.get(filename);
      const output = resolve(directory, `component-${compiled.size}.mjs`);
      compiled.set(filename, output);
      const { descriptor } = parse(await readFile(filename, 'utf8'));
      let { content } = compileScript(descriptor, { id: output, inlineTemplate: true });
      for (const match of [...content.matchAll(/from\s+(["'])(\.[^"']+)\1/g)]) {
        const dependency = resolve(dirname(filename), match[2]);
        const target = dependency.endsWith('market-data.js') ? adapter
          : dependency.endsWith('.vue') ? await compile(dependency) : dependency;
        content = content.replace(match[0], `from ${JSON.stringify(pathToFileURL(target).href)}`);
      }
      content = content.replaceAll('import.meta.env.BASE_URL', JSON.stringify('/'));
      await writeFile(output, content);
      return output;
    }
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({
      candles: Array.from({ length: 500 }, (_,i) => [now/1000-(500-i)*3600,80000,Math.max(81000,80000+i*10),79000,80000+i*10])
    }) }));
    const { createApp, nextTick } = await import('vue');
    const { state } = await import(pathToFileURL(adapter).href);
    const component = await import(pathToFileURL(await compile(fileURLToPath(new URL('./App.vue', import.meta.url)))).href);
    const root = window.document.createElement('div');
    window.document.body.append(root);
    app = createApp(component.default);
    app.mount(root);
    const settle = async () => { for (let i=0;i<12;i++) { await Promise.resolve(); await nextTick(); } };
    await settle();
    const strike = () => root.querySelector('.metric strong').textContent;
    assert.equal(strike(), '$80,000');
    const strikeLine = root.querySelector('.reference.strike');
    const strikeLabel = root.querySelector('.direct.strike');
    const spotLabel = root.querySelector('.direct.spot');
    assert.equal(Number(strikeLabel.getAttribute('y')) + 4, Number(strikeLine.getAttribute('y1')), 'strike label is anchored to its actual price line');
    assert.equal(strikeLabel.getAttribute('y'), spotLabel.getAttribute('y'), 'equal strike and spot prices use exactly the same y-coordinate');
    const wickYs = () => [...root.querySelectorAll('.candle > line')]
      .flatMap(line => [Number(line.getAttribute('y1')), Number(line.getAttribute('y2'))]);
    assert.ok(Math.abs(Math.min(...wickYs()) - 60.227) < 1, 'highest candle gets five-percent range padding');
    assert.ok(Math.abs(Math.max(...wickYs()) - 564.773) < 1, 'lowest candle gets five-percent range padding');
    assert.equal(root.querySelector('.chart-scroll svg').getAttribute('viewBox'), '0 0 1440 640', 'fitting changes only the price domain');
    assert.ok(root.querySelector('.chart-meta #expiry'), 'expiry sits in the chart toolbar');
    assert.equal(root.querySelector('.header #expiry'), null);
    const bodies = root.querySelectorAll('.candle > rect:not(.hitbox)');
    assert.ok(Math.abs(Number(bodies[bodies.length-1].getAttribute('y')) - (Number(spotLabel.getAttribute('y')) + 4)) < 1,
      'the latest displayed candle closes at the spot-label price');
    const initialFrequency = root.querySelectorAll('.metric strong')[3].textContent;
    root.querySelector('#candle-interval').click();
    await settle();
    const twelveHour = [...window.document.querySelectorAll('[role="option"]')]
      .find(option => option.textContent.includes('12-hour candles'));
    assert.ok(twelveHour, 'the interval label opens the available candle intervals');
    twelveHour.click();
    await settle();
    assert.match(root.querySelector('#candle-interval').textContent, /12-hour candles/);
    assert.ok(root.querySelectorAll('.candle').length < 50);
    [...root.querySelectorAll('.ranges button')].find(button => button.textContent === '2Y').click();
    await settle();
    assert.match(root.querySelector('#candle-interval').textContent, /12-hour candles/, 'an explicit interval survives range changes');
    assert.equal(root.querySelectorAll('.metric strong')[3].textContent, initialFrequency, 'view controls do not change the historical rule sample');

    state.hold = true;
    t.mock.timers.tick(61000);
    await settle();
    assert.equal(state.requests, 2, 'the app refreshes before the two-minute cutoff');
    assert.equal(strike(), '$80,000', 'a pending refresh does not blank an existing fresh trade');
    const slider = root.querySelector('[role="slider"]');
    const originalWicks = wickYs();
    const target = Number(slider.getAttribute('aria-valuenow'));
    slider.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await settle();
    assert.equal(Number(slider.getAttribute('aria-valuenow')), target+100);
    assert.equal(strike(), '$80,000', 'target changes still rank the retained fresh chain');
    // Pointer input uses the actual SVG-to-price conversion and keeps tracking
    // after the pointer moves beyond the initial line hit area.
    const svg = slider.ownerSVGElement;
    svg.getScreenCTM = () => ({ inverse: () => ({}) });
    svg.createSVGPoint = () => ({ x: 0, y: 0, matrixTransform() { return { x: this.x, y: this.y }; } });
    slider.setPointerCapture = () => {};
    const lineY = Number(root.querySelector('.target-line').getAttribute('y1'));
    slider.dispatchEvent(new window.PointerEvent('pointerdown', { button: 0, pointerId: 1, clientY: lineY, bubbles: true }));
    slider.dispatchEvent(new window.PointerEvent('pointermove', { pointerId: 1, clientY: lineY - 24, bubbles: true }));
    slider.dispatchEvent(new window.PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    await settle();
    assert.ok(Number(slider.getAttribute('aria-valuenow')) <= Number(slider.getAttribute('aria-valuemax')));
    assert.deepEqual(wickYs(), originalWicks, 'moving the target never compresses the candle scale');
    assert.notEqual(strike(), '—', 'pointer dragging keeps selecting a trade during refresh');
    const expectedStrike = strike();
    state.hold = false;
    state.release();
    await settle();
    for (let i=0;i<3;i++) {
      t.mock.timers.tick(61000);
      await settle();
      assert.equal(strike(), expectedStrike, 'refreshes keep the trade available beyond the original expiry cutoff');
    }
    // Crossing below spot immediately switches to already-loaded puts.
    slider.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await settle();
    assert.notEqual(strike(), '—');
    assert.match(root.querySelector('.metric-label').textContent, /Best put strike/);
    assert.match(root.querySelector('.metric .detail').textContent, /Buy put/);
    assert.equal(state.requests, 5, 'crossing spot does not request a different chain');
    slider.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await settle();
    assert.match(root.querySelector('.metric-label').textContent, /Best call strike/);
    assert.match(root.querySelector('.metric .detail').textContent, /Buy call/);
    const freshStrike = strike();
    assert.notEqual(freshStrike, '—');
    state.empty = true;
    t.mock.timers.tick(61000);
    await settle();
    assert.equal(strike(), freshStrike, 'a failed replacement preserves the previous fresh snapshot');
    t.mock.timers.tick(61000);
    await settle();
    assert.equal(strike(), '—', 'retained results are suppressed once they are actually stale');
    assert.match(root.querySelector('.notice').textContent, /Quotes expired/);
  } finally {
    app?.unmount();
    t.mock.timers.reset();
    await window.happyDOM.abort();
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
