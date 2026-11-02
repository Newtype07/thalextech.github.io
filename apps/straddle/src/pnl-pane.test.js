import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, compileScript } from "@vue/compiler-sfc";
import { Window } from "happy-dom";
import history from "./fixtures/btc-straddle-history.json" with { type: "json" };

// Compile the actual client components so the regression covers D3 pointer
// handlers, Vue updates and the app's pane visibility together, without an API.
async function compileComponents(directory) {
  const compiled = new Map();
  return async function compile(filename) {
    if (compiled.has(filename)) return compiled.get(filename);
    const output = resolve(directory, `component-${compiled.size}.mjs`);
    compiled.set(filename, output);
    const { descriptor } = parse(await readFile(filename, "utf8"));
    let { content } = compileScript(descriptor, { id: output, inlineTemplate: true });
    const imports = [...content.matchAll(/from\s+(["'])(\.[^"']+)\1/g)];
    for (const match of imports) {
      const dependency = resolve(dirname(filename), match[2]);
      const target = dependency.endsWith(".vue") ? await compile(dependency) : dependency;
      content = content.replace(match[0], `from ${JSON.stringify(pathToFileURL(target).href)}`);
    }
    await writeFile(output, content);
    return output;
  };
}

test("connecting two dots opens the P&L pane, switches position side, preserves selection, and closes cleanly", async t => {
  const appDirectory = fileURLToPath(new URL("../", import.meta.url));
  const temporary = await mkdtemp(resolve(appDirectory, ".component-test-"));
  const window = new Window({ url: "http://localhost/" });
  const globals = ["window", "document", "Node", "Element", "HTMLElement", "SVGElement"];
  const originals = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? window : window[key] });
  let app;
  try {
    t.mock.method(Date, "now", () => history.observations.at(-1).ts * 1000);
    t.mock.method(globalThis, "fetch", async input => {
      const url = new URL(input);
      let result;
      if (url.pathname.endsWith("/instruments")) {
        result = history.legs.map(leg => ({ instrument_name: leg.name, type: "option", underlying: "BTCUSD",
          strike_price: leg.strike, expiration_timestamp: leg.expiry, option_type: leg.type,
          create_time: history.observations[0].ts - 86400 }));
      } else if (url.pathname.endsWith("/index_price_historical_data")) {
        result = { index: history.observations.map(point => [point.ts, point.spot, point.spot, point.spot, point.spot]) };
      } else if (url.pathname.endsWith("/mark_price_historical_data")) {
        const leg = history.legs.findIndex(item => item.name === url.searchParams.get("instrument_name"));
        assert.ok(leg >= 0, "only selected fixture legs are requested");
        result = { mark: history.observations.map(point => [point.ts,
          ...Array(4).fill(point.marks[leg]), ...Array(4).fill(point.reportedIvs[leg])]) };
      } else {
        assert.fail(`Unexpected API request: ${url.pathname}`);
      }
      return { ok: true, json: async () => ({ result }) };
    });
    const compile = await compileComponents(temporary);
    const filename = await compile(fileURLToPath(new URL("./App.vue", import.meta.url)));
    const { createApp, nextTick } = await import("vue");
    const { default: App } = await import(pathToFileURL(filename).href);
    window.document.body.innerHTML = '<div id="app"></div>';
    const errors = [];
    app = createApp(App);
    app.config.errorHandler = error => errors.push(error);
    app.mount(window.document.querySelector("#app"));
    const settle = async () => {
      for (let i = 0; i < 6; i += 1) {
        await new Promise(resolve => setImmediate(resolve));
        await nextTick();
      }
      assert.deepEqual(errors, [], "no component runtime errors");
    };
    await settle();
    const button = [...window.document.querySelectorAll("button")].find(node => node.textContent.trim() === "Straddle P&L");
    assert.ok(button);
    button.click();
    await settle();
    const points = [...window.document.querySelectorAll("circle.main-point")];
    assert.equal(points.length, history.observations.length);
    assert.equal(window.document.querySelector(".pnlPane"), null);
    const select = async point => {
      point.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      await settle();
      // A resize can retarget the click generated after the original pointerdown.
      window.document.querySelector(".chartWrap").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await settle();
    };
    await select(points[0]);
    assert.equal(window.document.querySelector(".pnlPane"), null, "one dot does not open attribution");
    await select(points.at(-1));
    const pane = window.document.querySelector(".pnlPane");
    assert.ok(pane, "the second dot opens a pane alongside the chart");
    assert.ok(window.document.querySelector(".straddleWorkspace--selected"));
    assert.match(pane.textContent, /Greeks P&L/);
    assert.match(pane.textContent, /[−-]\$409\.71/);
    assert.equal(pane.querySelectorAll("svg").length, 1, "the pane contains one chart");
    assert.equal(pane.querySelector("table, details, input[type=file]"), null, "no report or upload UI");
    const longButton = pane.querySelector('[aria-label="Long position"]');
    const shortButton = pane.querySelector('[aria-label="Short position"]');
    assert.equal(longButton.getAttribute("aria-pressed"), "true", "positions start long");
    assert.equal(shortButton.getAttribute("aria-pressed"), "false");
    assert.match(pane.querySelector("#attribution-title").textContent, /P&L [−-]\$409\.71 · ROI [−-]13\.7%/, "the title shows total P&L and return on entry premium");
    assert.match(pane.querySelector(".range").textContent, /^Selected: /);
    const legend = [...pane.querySelectorAll('.legend [role="button"]')];
    assert.deepEqual(legend.map(node => node.getAttribute("aria-label")), ["Total", "Delta", "Gamma − Theta", "Vega", "Model diff."]);
    assert.match(legend.find(node => node.getAttribute("aria-label") === "Delta").querySelector("title").textContent, /stays fixed/);
    const components = legend.map(node => Number(node.querySelector(".composition-value").textContent.replaceAll("−", "-").replaceAll(/[$,]/g, "")));
    assert.ok(Math.abs(components[0] - components.slice(1).reduce((sum, value) => sum + value, 0)) < 0.03, "the numeric composition sums to total P&L");
    const leftTitle = [...window.document.querySelectorAll(".chartWrap svg text")].find(node => node.textContent.includes("STRADDLE"));
    const rightTitle = pane.querySelector("#attribution-title");
    assert.equal(pane.querySelector("svg").getAttribute("font-family"), leftTitle.style.fontFamily, "chart titles use the same font family");
    assert.equal(Number(rightTitle.getAttribute("font-size")), parseFloat(leftTitle.style.fontSize), "chart titles use the same font size");
    assert.equal(rightTitle.getAttribute("y"), leftTitle.getAttribute("y"), "title baselines align");
    const leftSubtitle = leftTitle.nextElementSibling;
    assert.equal(pane.querySelector(".range").getAttribute("y"), leftSubtitle.getAttribute("y"), "subtitle baselines align");
    assert.equal(pane.querySelectorAll("path.pnl-line").length, 5);
    assert.ok(pane.querySelector(".total-area"), "total P&L has a gradient fill");
    legend[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.equal(pane.querySelector(".total-area"), null, "hiding total P&L also hides its fill");
    legend[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.ok(pane.querySelector(".total-area"));
    legend.find(node => node.getAttribute("aria-label") === "Gamma − Theta").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.equal(pane.querySelector('path[data-series="gammaTheta"]'), null, "legend toggles the combined gamma and theta line");
    assert.equal(legend[2].querySelector(".composition-value").textContent, "−$217.17", "time decay is deducted from convexity and remains in the composition when hidden");
    legend.find(node => node.getAttribute("aria-label") === "Gamma − Theta").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.ok(pane.querySelector('path[data-series="gammaTheta"]'));
    assert.equal(window.document.querySelector(".chartWrap svg").getAttribute("viewBox"), "0 0 640 620");

    const originalRange = pane.querySelector(".range").textContent;
    const longPaths = [...pane.querySelectorAll("path.pnl-line")].map(node => node.getAttribute("d"));
    const svg = pane.querySelector("svg");
    t.mock.method(svg, "getBoundingClientRect", () => ({ left: 0, top: 0, width: 640, height: 620 }));
    const hoverLastPoint = () => svg.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 602, clientY: 300 }));
    hoverLastPoint();
    await settle();
    const tooltipValues = () => [...pane.querySelectorAll(".tooltip-value span:last-child")].map(node => node.textContent);
    const longTooltipValues = tooltipValues();
    assert.equal(longTooltipValues.length, components.length);
    const requestsBeforeToggle = globalThis.fetch.mock.callCount();
    shortButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.equal(shortButton.getAttribute("aria-pressed"), "true");
    assert.equal(longButton.getAttribute("aria-pressed"), "false");
    assert.match(pane.querySelector("#attribution-title").textContent, /^Short P&L \$409\.71 · ROI 13\.7%$/, "short ROI uses the absolute entry premium");
    const shortComponents = legend.map(node => Number(node.querySelector(".composition-value").textContent.replaceAll("−", "-").replaceAll(/[$,]/g, "")));
    shortComponents.forEach((value, index) => assert.ok(Math.abs(value + components[index]) < 0.005, "all attribution components reverse sign"));
    assert.notDeepEqual([...pane.querySelectorAll("path.pnl-line")].map(node => node.getAttribute("d")), longPaths, "chart lines update for the short position");
    assert.notDeepEqual(tooltipValues(), longTooltipValues, "hover values update with the side");
    assert.equal(tooltipValues()[0], "$409.71");
    assert.equal(pane.querySelector(".range").textContent, originalRange, "toggling side preserves the selected range");
    assert.equal(globalThis.fetch.mock.callCount(), requestsBeforeToggle, "side changes use the loaded history");

    longButton.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    assert.match(pane.querySelector("#attribution-title").textContent, /^Long P&L [−-]\$409\.71 · ROI [−-]13\.7%$/);
    assert.deepEqual([...pane.querySelectorAll("path.pnl-line")].map(node => node.getAttribute("d")), longPaths);
    assert.deepEqual(tooltipValues(), longTooltipValues);
    shortButton.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await settle();
    assert.equal(shortButton.getAttribute("aria-pressed"), "true", "space selects the short position");
    await select(points[10]);
    assert.ok(window.document.querySelector(".pnlPane"), "a third dot updates the open pane");
    assert.notEqual(window.document.querySelector(".pnlPane .range").textContent, originalRange);
    assert.equal(shortButton.getAttribute("aria-pressed"), "true", "updating the range keeps the position side");

    window.document.querySelector(".chartWrap").click();
    await settle();
    assert.equal(window.document.querySelector(".pnlPane"), null);
    assert.equal(window.document.querySelector(".chartWrap svg").getAttribute("viewBox"), "0 0 1316 620");

    await select(points[0]);
    await select(points.at(-1));
    assert.ok(window.document.querySelector(".pnlPane"), "selection can open the pane again");
    window.document.querySelector(".chartWrap").click();
    await settle();
    assert.equal(window.document.querySelector(".pnlPane"), null, "clicking the background closes attribution");
  } finally {
    app?.unmount();
    await window.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
