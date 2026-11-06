import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, compileScript } from "@vue/compiler-sfc";
import { Window } from "happy-dom";
import { transformWithEsbuild } from "vite";
import { builderExpiry } from "./simulation/position-selection.js";
import { calcGreeks } from "../../../lib/thalex.js";

// Exercise the real templates and SVG output, without an exchange connection.
async function compiler(directory) {
  const compiled = new Map();
  return async function compile(filename) {
    if (compiled.has(filename)) return compiled.get(filename);
    const output = resolve(directory, `component-${compiled.size}.mjs`);
    compiled.set(filename, output);
    const { descriptor } = parse(await readFile(filename, "utf8"));
    let { content } = compileScript(descriptor, {
      id: output,
      inlineTemplate: true,
    });
    if (descriptor.scriptSetup?.lang === "ts")
      content = (await transformWithEsbuild(content, filename, { loader: "ts" })).code;
    for (const match of [...content.matchAll(/from\s+(["'])(\.[^"']+)\1/g)]) {
      let dependency = resolve(dirname(filename), match[2]);
      if (!/\.(?:vue|js|ts|mjs)$/.test(dependency)) dependency += ".ts";
      const target = dependency.endsWith(".vue")
        ? await compile(dependency)
        : dependency;
      content = content.replace(
        match[0],
        `from ${JSON.stringify(pathToFileURL(target).href)}`,
      );
    }
    await writeFile(output, content);
    return output;
  };
}

test("performance UI reuses paths on policy edits and refreshes explicitly, inspects, exports, and preserves results across tabs", async (t) => {
  const directory = await mkdtemp(
    fileURLToPath(new URL("../.simulation-test-", import.meta.url)),
  );
  const window = new Window({ url: "http://localhost/" });
  const values = {
    window,
    WebSocket: undefined,
    document: window.document,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
  };
  const originals = new Map(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  let app;
  try {
    let pathSeed = 42;
    t.mock.method(globalThis.crypto, "getRandomValues", (values) => {
      values[0] = pathSeed++;
      return values;
    });
    const compile = await compiler(directory);
    const file = await compile(
      fileURLToPath(
        new URL("./components/PositionSimulator.vue", import.meta.url),
      ),
    );
    const { createApp, nextTick, h, reactive } = await import("vue");
    const { default: Simulator } = await import(pathToFileURL(file).href);
    const errors = [];
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 170));
      await nextTick();
    };
    const mount = (component, props) => {
      window.document.body.innerHTML = '<div id="app"></div>';
      app = createApp(component, props);
      app.config.errorHandler = (error) => errors.push(error);
      app.mount(window.document.querySelector("#app"));
    };
    const root = () => window.document.querySelector("#app");
    const button = (text) =>
      [...root().querySelectorAll("button")].find(
        (node) => node.textContent.trim() === text || node.getAttribute("aria-label") === text,
      );
    const input = (text) => {
      const labelled = [...root().querySelectorAll("input, select")].find(
        (node) => node.getAttribute("aria-label") === text,
      );
      if (labelled) return labelled;
      const label = [...root().querySelectorAll("label")].find((node) =>
        node.textContent.trim().startsWith(text),
      );
      return label?.htmlFor
        ? window.document.getElementById(label.htmlFor)
        : label?.querySelector("input, select");
    };
    const set = async (label, value) => {
      const element = input(label);
      assert.ok(element, `input exists: ${label}`);
      element.value = String(element.dataset.valueScale ? Number(value) * Number(element.dataset.valueScale) : value);
      element.dispatchEvent(
        new window.Event(element.tagName === "SELECT" ? "change" : "input", {
          bubbles: true,
        }),
      );
      await nextTick();
    };
    const chain = (asOf, days = [1, 7]) => days.flatMap(day => [90000, 92000].flatMap(strike =>
      ["C", "P"].map(side => ({ name: `BTC-${day}-${strike}-${side}`, expiry: asOf + day * 86400, strike, side }))));
    const selectLeg = async (index, label, text) => {
      if (label === "Option expiry" && !root().querySelector('[aria-label="Option expiry"]')) {
        root().querySelector('[aria-label="Edit maturities per leg"]').click();
        await nextTick();
      }
      root().querySelectorAll(".leg-row")[index].querySelector(`[aria-label="${label}"]`).click();
      await nextTick();
      const option = [...window.document.querySelectorAll('[role="option"]')]
        .find(node => node.querySelector("span").textContent.trim() === text);
      assert.ok(option, `${label} option exists: ${text}`);
      option.click();
      await settle();
    };
    const initialMarket = reactive({
      asset: "BTC",
      instruments: chain(1793700000),
      liveSpot: 91000,
      asOf: 1793700000,
      liveCurve: [
        { seconds: 86400, iv: 0.7, strike: 90000 },
        { seconds: 7 * 86400, iv: 0.6, strike: 92000 },
      ],
    });
    mount({ setup: () => () => h(Simulator, initialMarket) });
    await settle();
    assert.ok(
      root().querySelector(".sim-performance"),
      `ready market data starts a default run without submitting the form: ${[...root().querySelectorAll("input")].filter(input => !input.checkValidity()).map(input => `${input.type} ${input.value} step=${input.step} stepMismatch=${input.validity.stepMismatch} missing=${input.validity.valueMissing}`).join("; ")} ${errors.map(error => error.stack).join("\n")}`,
    );
    const holding = input("Holding horizon");
    assert.equal(holding.type, "range");
    assert.equal(holding.min, "0");
    assert.equal(holding.max, "10");
    assert.equal(holding.value, "6", "holding horizon defaults to seven days");
    assert.equal(Number([...root().querySelectorAll(".cumulative-pnl-bar")].at(-1).dataset.elapsed), 7 * 86400);
    const originalHorizonPath = root().querySelector(".index-price-path").getAttribute("d");
    const horizonSeed = pathSeed;
    for (const [index, days] of [1, 2, 3, 4, 5, 6, 7, 14, 30, 60, 90].entries()) {
      await set("Holding horizon", index);
      assert.ok(holding.getAttribute("aria-valuetext").startsWith(`${days} ${days === 1 ? 'day' : 'days'}`));
      assert.match(root().querySelector('.sim-horizon-control output').textContent, new RegExp(`^${days}d`));
    }
    await settle();
    assert.equal(Number([...root().querySelectorAll(".cumulative-pnl-bar")].at(-1).dataset.elapsed), 7 * 86400, "a requested horizon beyond the last expiry caps at expiry");
    assert.match(holding.getAttribute("aria-valuetext"), /last option expiry/);
    await set("Holding horizon", 0); await settle();
    assert.equal(Number([...root().querySelectorAll(".cumulative-pnl-bar")].at(-1).dataset.elapsed), 86400, "shorter holding horizons close the account before expiry");
    assert.equal(root().querySelector(".performance-time").textContent, "At selected exit");
    await set("Holding horizon", 6); await settle();
    assert.equal(root().querySelector(".index-price-path").getAttribute("d"), originalHorizonPath, "restoring the horizon restores the same seeded path");
    assert.equal(pathSeed, horizonSeed, "horizon changes do not request new random draws");
    assert.equal(root().querySelectorAll(".leg-row").length, 2);
    assert.equal(root().querySelector(".combination-heading h1"), null, "the builder does not repeat the selected legs in a title");
    assert.equal(root().querySelector('[aria-label="Combination maturity"]').textContent.trim(), builderExpiry(1793700000 + 7 * 86400));
    assert.equal(root().querySelectorAll('[aria-label="Option expiry"]').length, 0);
    assert.ok(root().querySelector('[aria-label="Edit maturities per leg"]'));
    for (const row of root().querySelectorAll(".leg-row")) {
      assert.match(row.querySelector(".side-pill").getAttribute("aria-label"), /^Sell leg/);
      assert.equal(row.querySelector(".qty-input").value, "1");
      assert.equal(row.querySelector('[aria-label="Option strike"]').textContent.trim(), "90,000");
    }
    assert.equal(input("Realized / forward volatility").value, "100");
    assert.equal(root().querySelector('[role="group"][aria-label="Simulate until"]'), null, "a single maturity has no redundant exit choice");
    const callGreeks = root().querySelector(".leg-row").querySelectorAll(".leg-greek-value");
    assert.equal(callGreeks[0].textContent.trim(), "60.00%");
    assert.equal(callGreeks[2].textContent.trim(), (-calcGreeks(91000, 90000, 7 * 86400, 0.6, "call").delta).toFixed(2));
    // Opening per-leg editing preserves the shared date metadata; the mode is reversible.
    button("Edit maturities per leg").click();
    await nextTick();
    assert.equal(root().querySelectorAll('[aria-label="Option expiry"]').length, 2);
    assert.equal(button("Combination maturity").textContent.trim(), builderExpiry(1793700000 + 7 * 86400));
    assert.ok(root().querySelector(".maturity-tte"));
    button("Use a single maturity").click();
    await nextTick();
    assert.equal(root().querySelectorAll('[aria-label="Option expiry"]').length, 0);
    // A mixed position can return to the first leg's date, then bulk-change from the dropdown.
    await selectLeg(0, "Option expiry", builderExpiry(1793700000 + 86400));
    assert.equal(button("Combination maturity").textContent.trim(), "Mixed maturities");
    button("Use a single maturity").click();
    await settle();
    assert.equal(root().querySelectorAll('[aria-label="Option expiry"]').length, 0);
    assert.equal(button("Combination maturity").textContent.trim(), builderExpiry(1793700000 + 86400));
    button("Edit maturities per leg").click();
    await nextTick();
    for (const row of root().querySelectorAll(".leg-row"))
      assert.equal(row.querySelector('[aria-label="Option expiry"]').textContent.trim(), builderExpiry(1793700000 + 86400));
    button("Combination maturity").click();
    await nextTick();
    [...window.document.querySelectorAll('[role="option"]')]
      .find(node => node.querySelector("span").textContent.trim() === builderExpiry(1793700000 + 7 * 86400)).click();
    await settle();
    assert.equal(root().querySelectorAll('[aria-label="Option expiry"]').length, 0);
    button("Edit maturities per leg").click();
    await nextTick();
    for (const row of root().querySelectorAll(".leg-row"))
      assert.equal(row.querySelector('[aria-label="Option expiry"]').textContent.trim(), builderExpiry(1793700000 + 7 * 86400));
    button("Use a single maturity").click();
    await nextTick();
    assert.equal(root().querySelector(".settings-side-panel"), null, "hedge settings start closed, as in Combo P&L");
    const beforeHiding = pathSeed;
    const configure = button("Configure hedge settings");
    assert.equal(configure.textContent.trim(), "Configure");
    configure.click();
    await settle();
    const sidebar = root().querySelector(".settings-side-panel");
    assert.ok(sidebar);
    assert.equal(sidebar.parentElement.id, "term-sim-settings-dock", "the shared panel occupies a separate layout column");
    assert.ok(sidebar.closest("form"), "teleported controls remain within the simulation form for validation");
    assert.ok(sidebar.querySelector('[role="separator"]'), "the panel uses the shared width resizer");
    assert.ok(sidebar.querySelector("header [role=switch]"), "the hedge toggle sits beside the panel title");
    assert.equal(sidebar.querySelector(".settings-panel-content [role=switch]"), null, "the panel body does not duplicate the header toggle");
    assert.ok(![...sidebar.querySelectorAll("label")].some(node => node.textContent.startsWith("RV / forward IV")), "the panel omits the ratio already controlled by the toolbar slider");
    assert.equal(input("Realized / forward volatility").type, "range");
    assert.match(root().querySelector(".hedge-explanation").textContent, /resets the timer/);
    assert.equal(button("Update market snapshot"), undefined);
    assert.doesNotMatch(root().textContent, /seed/i);
    button("Close settings").click();
    await settle();
    assert.equal(root().querySelector(".settings-side-panel"), null);
    assert.equal(configure.getAttribute("aria-expanded"), "false");
    configure.click();
    await settle();
    assert.ok(root().querySelector(".settings-side-panel"));
    assert.equal(pathSeed, beforeHiding, "hiding and showing settings preserves the run");
    assert.match(
      root().querySelector(".sim-snapshot").textContent,
      /Live ATM marks/,
    );
    for (const removed of [
      "Entry spot",
      "Size",
      "Fixed strike",
      "Close after",
      "IV shift",
      "Path seed",
      "Path step",
    ])
      assert.equal(input(removed), undefined);
    assert.match(
      root().querySelector(".sim-position-builder").textContent,
      /91,000/,
    );
    for (const index of [0, 1]) {
      await selectLeg(index, "Option expiry", builderExpiry(1793700000 + 86400));
      await selectLeg(index, "Option strike", "90,000");
    }
    assert.equal(input("Annual drift").value, "0");
    const ratio = input("Realized / forward volatility");
    assert.equal(ratio.type, "range");
    assert.equal(ratio.min, "50");
    assert.equal(ratio.max, "200");
    await set("Realized / forward volatility", 50);
    await settle();
    assert.equal(errors.length, 0);
    assert.ok(
      root().querySelector(".sim-performance"),
      [...root().querySelectorAll("input, select")]
        .filter((element) => !element.validity.valid)
        .map(
          (element) =>
            `${element.parentElement.textContent.trim()}: ${element.validationMessage}`,
        )
        .join("; "),
    );
    assert.equal(root().querySelectorAll(".combined-chart").length, 1, "price and cumulative P&L share one chart");
    const bars = root().querySelectorAll(".cumulative-pnl-bar");
    assert.ok(bars.length >= 12 && bars.length <= 160, "readable cumulative bars sample the minute ledger");
    assert.equal(root().querySelectorAll(".shared-time-axis").length, 1, "both lanes use one time axis");
    assert.equal(root().querySelector("[stroke-dasharray]"), null, "the merged chart has no dashed guide");
    assert.equal(root().querySelector(".sim-performance h2, .performance-subtitle, .sim-trade-facts, .performance-note"), null, "the chart has no redundant title, scope row or explanatory footer");
    assert.equal(root().querySelectorAll(".leg-row").length, 2);
    assert.equal(
      root().querySelectorAll(".pnl-key .performance-value").length,
      3,
    );
    assert.equal(
      root().querySelectorAll(".combined-chart .index-price-path").length,
      1,
    );
    assert.ok(root().querySelector(".index-lane").compareDocumentPosition(root().querySelector(".pnl-lane")) &
      window.Node.DOCUMENT_POSITION_FOLLOWING, "cumulative P&L bars sit below price and hedge fills");
    assert.equal(input("Annual drift").value, "0");
    const tradeDots = root().querySelectorAll(".combined-chart .hedge-trade-dot");
    assert.ok(tradeDots.length > 2);
    assert.ok(
      root().querySelector('.hedge-trade-dot.buy-dot[data-side="buy"]'),
    );
    assert.ok(
      root().querySelector('.hedge-trade-dot.sell-dot[data-side="sell"]'),
    );
    assert.ok(root().querySelector('.hedge-trade-dot[data-trigger="entry"]'));
    assert.ok(root().querySelector('.hedge-trade-dot[data-trigger="exit"]'));
    for (const dot of tradeDots) {
      assert.ok(Number.isFinite(Number(dot.getAttribute("cx"))));
      assert.ok(Number.isFinite(Number(dot.getAttribute("cy"))));
      assert.match(dot.textContent, /(?:Buy|Sell).*BTC.*day/s);
    }

    assert.equal(
      root().querySelector(".sim-metrics, .sim-breakdown, .sim-inspection"),
      null,
    );
    assert.doesNotMatch(
      root().querySelector(".sim-performance").textContent,
      /[Gg]reeks|[Dd]elta|[Vv]olatility/,
    );
    const lowerRvLegend = root().querySelector(".pnl-key").textContent;
    await set("Realized / forward volatility", 200);
    await settle();
    assert.notEqual(
      root().querySelector(".pnl-key").textContent,
      lowerRvLegend,
    );
    assert.equal(root().querySelector(".performance-summary, .run-stat, .run-scope"), null);
    const noDriftPrice = root().querySelector(".index-price").textContent;
    await set("Annual drift", 20);
    await settle();
    assert.equal(input("Annual drift").value, "20");
    assert.notEqual(
      root().querySelector(".index-price").textContent,
      noDriftPrice,
    );
    await set("Annual drift", -20);
    await settle();
    assert.equal(input("Annual drift").value, "-20");
    assert.equal(root().querySelector(".hedge-comparison"), null, "hedge comparison has been removed");
    const firstMetrics = root().querySelector(".sim-performance").textContent;
    await set("Threshold", 0.1);
    assert.ok(root().querySelector(".sim-pending"));
    assert.equal(
      root().querySelector(".sim-performance").textContent,
      firstMetrics,
      "the previous result stays visible until the automatic update completes",
    );
    await settle();
    assert.equal(root().querySelector(".sim-pending"), null);
    const svg = root().querySelector(".combined-chart");
    const pnlSvg = root().querySelector(".combined-chart");
    t.mock.method(pnlSvg, "getBoundingClientRect", () => ({ left: 0, width: 1280 }));
    for (const [seconds, expectedDay] of [[30, "0.000"], [61, "0.001"]]) {
      pnlSvg.dispatchEvent(new window.MouseEvent("pointermove", {
        clientX: 78 + (1242 - 78) * seconds / 86400,
        bubbles: true,
      }));
      await nextTick();
      assert.equal(
        root().querySelector(".performance-time").textContent,
        `Day ${expectedDay}`,
        "step inspection uses the current interval's observation, never a future one",
      );
    }
    svg.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    await nextTick();
    assert.match(
      root().querySelector(".performance-time").textContent,
      /Day 0.000/,
    );
    assert.equal(root().querySelector(".index-time").textContent, "Day 0.000");
    assert.ok(root().querySelector(".index-cursor"));
    assert.ok(root().querySelector(".performance-cursor"));
    assert.equal(root().querySelector("[stroke-dasharray]"), null, "inspection highlights values without a dashed guide");

    const openingValues = [
      ...root().querySelectorAll(".performance-value strong"),
    ].map((node) => Number(node.textContent.replace(/[^\d.-]/g, "")));
    assert.ok(
      Math.abs(openingValues[0] + openingValues[1] - openingValues[2]) <= 1,
      "whole-dollar components reconcile with total within rounding",
    );
    svg.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await nextTick();
    assert.match(
      root().querySelector(".performance-time").textContent,
      /Day 0.001/,
    );
    svg.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await nextTick();
    assert.equal(
      root().querySelector(".performance-time").textContent,
      "At expiry",
    );
    const blobs = [];
    const downloads = [];
    t.mock.method(window.HTMLAnchorElement.prototype, "click", function () {
      downloads.push(this.download);
    });
    t.mock.method(URL, "createObjectURL", (blob) => {
      blobs.push(blob);
      return "blob:test";
    });
    button("Export CSV").click();
    await nextTick();
    assert.equal(blobs.length, 1);
    assert.deepEqual(downloads, ["BTC-position.csv"]);
    const csvRows = (await blobs[0].text())
      .trim()
      .split("\n")
      .slice(1)
      .map((row) => row.split(",").map(Number));
    assert.equal(csvRows.length, 1441, "a one-day run has one-minute observations plus entry");
    const renderedBars = [...root().querySelectorAll(".cumulative-pnl-bar")];
    const exportedPnl = new Map(csvRows.map(values => [values[0], values[4]]));
    for (const bar of renderedBars) {
      assert.equal(Number(bar.dataset.pnl), exportedPnl.get(Number(bar.dataset.elapsed)), "each bar shows an actual cumulative ledger value, never a sum or average");
    }
    assert.equal(Number(renderedBars[0].dataset.elapsed), 0, "bars include entry execution costs");
    assert.equal(Number(renderedBars.at(-1).dataset.pnl), csvRows.at(-1)[4], "the last bar includes expiry and hedge unwind costs");
    csvRows.slice(1).forEach((values, i) => {
      assert.equal(values[0] - csvRows[i][0], 60, "the path step is always one minute");
    });
    for (const values of csvRows)
      assert.ok(
        Math.abs(values[2] + values[3] - values[4]) < 1e-6,
        "exported net components reconcile at every step",
      );
    const expiryValues = [...root().querySelectorAll(".performance-value strong")]
      .map(node => Number(node.textContent.replace(/[^\d.-]/g, "")));
    expiryValues.forEach((value, i) => {
      assert.ok(Math.abs(value - csvRows.at(-1)[i + 2]) <= 0.5, "legend values match exported expiry P&L");
    });
    assert.match(
      await blobs[0].text(),
      /^elapsedSeconds,spot,optionPnl,hedgePnl,totalPnl,executionCosts/,
    );
    const oldPath = root().querySelector(".index-price-path").getAttribute("d");
    button("Refresh simulation").click();
    await settle();
    assert.notEqual(
      root().querySelector(".index-price-path").getAttribute("d"),
      oldPath,
      "rerunning unchanged settings generates a fresh price path",
    );
    await set("Tolerance", 0.01);
    await settle();
    assert.equal(root().querySelector('[role="alert"]'), null, "tolerance is constrained instead of producing an error");
    assert.equal(input("Tolerance").value, input("Threshold").value);
    assert.ok(
      root().querySelector(".sim-performance"),
      "constrained settings keep the simulation available",
    );
    await set("Tolerance", 0.15);
    await settle();
    assert.equal(root().querySelector('[role="alert"]'), null);
    assert.equal(button("100 runs"), undefined);
    assert.equal(button("Single run"), undefined);
    assert.equal(root().querySelector(".sim-ensemble"), null);
    // Select a trade within the existing path, then resize, move, and reset it.
    const fixedPath = root().querySelector(".index-price-path").getAttribute("d");
    const brushMouse = (target, type, minute) => target.dispatchEvent(new window.MouseEvent(type, {
      view: window, clientX: 78 + 1164 * minute / 1440 + .01, clientY: 100,
      button: 0, bubbles: true, cancelable: true,
    }));
    const prepareBrush = () => {
      root().querySelector(".combined-chart").createSVGPoint = undefined;
      const brush = root().querySelector(".brush");
      brush.getBoundingClientRect = () => ({ left: 0, top: 0 });
      Object.defineProperties(brush, { clientLeft: { configurable: true, value: 0 }, clientTop: { configurable: true, value: 0 } });
      return brush;
    };
    let selectionBrush = prepareBrush();
    const assertNoSelection = () => {
      assert.equal(root().querySelector(".trade-window-background"), null);
      assert.equal(root().querySelector(".trade-window-spotlight"), null);
      assert.equal(root().querySelector(".trade-boundary-label"), null);
      assert.equal(selectionBrush.querySelector(".selection").style.display, "none");
    };
    assertNoSelection();
    assert.equal(Number(root().querySelector(".cumulative-pnl-bar").dataset.elapsed), 0);
    assert.equal(Number([...root().querySelectorAll(".cumulative-pnl-bar")].at(-1).dataset.elapsed), 86400,
      "the unselected baseline evaluates the whole path");
    assert.equal(Number(root().querySelector('[data-trigger="entry"]').dataset.elapsed), 0);
    assert.equal(Number(root().querySelector('[data-trigger="exit"]').dataset.elapsed), 86400);
    brushMouse(selectionBrush.querySelector(".overlay"), "mousedown", 60);
    await nextTick();
    assert.equal(root().querySelector(".trade-window-spotlight"), null, "pointer down alone does not create a visible selection");
    brushMouse(window, "mouseup", 60);
    await settle();
    assertNoSelection();
    brushMouse(selectionBrush.querySelector(".overlay"), "mousedown", 60);
    brushMouse(window, "mousemove", 180);
    await nextTick();
    assert.equal(Number(root().querySelector(".trade-window-spotlight").dataset.entryElapsed), 61 * 60, "live labels snap to the next minute inside the selection");
    assert.equal(Number(root().querySelector(".trade-window-spotlight").dataset.exitElapsed), 180 * 60);
    assert.equal(Number(root().querySelector(".cumulative-pnl-bar").dataset.elapsed), 0, "drag previews do not commit the account until release");
    brushMouse(window, "mouseup", 180);
    await settle();
    assert.equal(root().querySelector(".index-price-path").getAttribute("d"), fixedPath, "selecting a trade preserves the full price path");
    assert.equal(Number(root().querySelector(".cumulative-pnl-bar").dataset.elapsed), 61 * 60, `${errors.map(e => e.stack).join("\n")} status=${root().querySelector(".sim-status")?.textContent}`);
    assert.equal(Number([...root().querySelectorAll(".cumulative-pnl-bar")].at(-1).dataset.elapsed), 180 * 60);
    assert.equal(root().querySelector(".performance-time").textContent, "At selected exit");
    assert.equal(Number(root().querySelector('[data-trigger="entry"]').dataset.elapsed), 61 * 60);
    assert.equal(Number(root().querySelector('[data-trigger="exit"]').dataset.elapsed), 180 * 60);
    button("Export CSV").click(); await nextTick();
    const windowRows = (await blobs.at(-1).text()).trim().split("\n").slice(1).map(row => row.split(",").map(Number));
    assert.equal(windowRows[0][0], 61 * 60);
    assert.equal(windowRows.at(-1)[0], 180 * 60);
    assert.ok(windowRows[0][4] < 0, "entry costs are charged in the new ledger");
    selectionBrush = prepareBrush();
    brushMouse(selectionBrush.querySelector(".handle--e"), "mousedown", 180);
    brushMouse(window, "mousemove", 240);
    brushMouse(window, "mouseup", 240);
    await settle();
    assert.equal(Number([...root().querySelectorAll(".cumulative-pnl-bar")].at(-1).dataset.elapsed), 240 * 60, "the exit edge resizes the window");
    selectionBrush = prepareBrush();
    brushMouse(selectionBrush.querySelector(".selection"), "mousedown", 120);
    brushMouse(window, "mousemove", 180);
    brushMouse(window, "mouseup", 180);
    await settle();
    assert.equal(Number(root().querySelector(".cumulative-pnl-bar").dataset.elapsed), 121 * 60, "dragging inside moves the trade window");
    selectionBrush.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    await settle();
    assert.equal(Number(root().querySelector(".cumulative-pnl-bar").dataset.elapsed), 0);
    assert.equal(Number([...root().querySelectorAll(".cumulative-pnl-bar")].at(-1).dataset.elapsed), 86400);
    assert.equal(root().querySelector(".index-price-path").getAttribute("d"), fixedPath);
    selectionBrush = prepareBrush();
    assertNoSelection();
    if (!root().querySelector(".settings-side-panel")) { configure.click(); await settle(); }
    for (const [label, value] of [
      ["Period", 4],
      ["Hedge execution cost", 2],
      ["Option cost", 2],
    ]) {
      const previousPath = root().querySelector(".index-price-path").getAttribute("d");
      await set(label, value);
      await settle();
      assert.equal(
        root().querySelector(".index-price-path").getAttribute("d"),
        previousPath,
        `${label} reruns accounting on the same market path`,
      );
      assert.equal(root().querySelector('[role="alert"]'), null);
    }
    assert.match(root().querySelector(".hedge-explanation").textContent, /1 hour. Returning inside resets the timer/);
    const beforeTyping = pathSeed;
    await set("Threshold", 0.11);
    await set("Threshold", 0.12);
    await settle();
    assert.equal(pathSeed, beforeTyping, "policy edits preserve the random path");
    const beforeInvalid = root().querySelector(".index-price-path").getAttribute("d");
    await set("Annual drift", "");
    await settle();
    assert.match(root().querySelector('[role="alert"]').textContent, /Complete all settings/);
    assert.equal(root().querySelector(".index-price-path").getAttribute("d"), beforeInvalid);
    await set("Annual drift", 0);
    await settle();
    assert.equal(root().querySelector('[role="alert"]'), null);
    for (const row of root().querySelectorAll(".leg-row")) {
      row.querySelector(".side-pill").click();
      await nextTick();
    }
    await settle();
    for (const row of root().querySelectorAll(".leg-row"))
      assert.match(row.querySelector(".side-pill").getAttribute("aria-label"), /^Buy leg/);
    // Build a short near call / long far call calendar through the shared controls.
    root().querySelectorAll(".leg-row")[0].querySelector(".side-pill").click();
    await nextTick();
    root().querySelectorAll(".leg-row")[1].querySelector(".type-pill").click();
    await nextTick();
    await selectLeg(1, "Option expiry", builderExpiry(1793700000 + 7 * 86400));
    assert.match(root().querySelector(".sim-settings-panel").textContent, /Drag on the index chart/);
    assert.equal(root().querySelector(".performance-time").textContent, "At last expiry");
    assert.equal(button("First expiry"), undefined);
    assert.equal(button("Last expiry"), undefined);
    const validCurve = initialMarket.liveCurve;
    initialMarket.liveCurve = [{ seconds: 86400, iv: 0.7, strike: 90000 }];
    await settle();
    assert.equal(root().querySelector('[role="alert"]'), null, "background quotes preserve the captured market snapshot");
    initialMarket.liveCurve = validCurve;
    await settle();
    assert.equal(root().querySelector('[role="alert"]'), null);
    button("Export CSV").click(); await nextTick();
    const lastExpiryRows = (await blobs.at(-1).text()).trim().split("\n").slice(1).map(row => row.split(",").map(Number));
    assert.equal(lastExpiryRows.at(-1)[0], 7 * 86400, "the selectable path spans the last expiry");
    await selectLeg(1, "Option expiry", builderExpiry(1793700000 + 86400));
    assert.equal(root().querySelector(".performance-time").textContent, "At expiry");
    await selectLeg(1, "Option expiry", builderExpiry(1793700000 + 7 * 86400));
    assert.equal(root().querySelector(".performance-time").textContent, "At last expiry");
    assert.equal(root().querySelectorAll(".leg-row").length, 2);
    const calendarPath = root().querySelector(".index-price-path").getAttribute("d");
    const quantity = root().querySelectorAll(".leg-row")[1].querySelector(".qty-input");
    quantity.value = "2";
    quantity.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle();
    assert.equal(root().querySelector(".index-price-path").getAttribute("d"), calendarPath, "quantity changes preserve the market path");
    assert.equal(root().querySelector('[role="alert"]'), null);
    for (const count of [3, 4]) {
      button("+ Add leg").click();
      await settle();
      assert.equal(root().querySelectorAll(".leg-row").length, count);
    }
    assert.equal(button("+ Add leg"), undefined, "the shared builder supports four legs");
    root().querySelectorAll(".remove-btn")[3].click();
    await settle();
    assert.equal(root().querySelectorAll(".leg-row").length, 3);
    for (const remove of root().querySelectorAll(".remove-btn")) {
      remove.click();
      await nextTick();
    }
    await settle();
    assert.match(root().querySelector('[role="status"]').textContent, /Add an option leg/);
    assert.equal(root().querySelectorAll(".leg-row").length, 0);
    button("+ Add leg").click();
    await settle();
    assert.equal(root().querySelectorAll(".leg-row").length, 1);
    assert.deepEqual(errors, []);
    app.unmount();

    const liveMarket = reactive({
      asset: "BTC",
      instruments: chain(1793700000, [1]),
      liveSpot: 91000,
      asOf: 1793700000,
      liveCurve: [{ seconds: 86400, iv: 0.7, strike: 90000, ready: false }],
      marketLoading: true,
      marketProgress: { checked: 1, total: 6 },
      marketCooldown: 0,
    });
    mount({ setup: () => () => h(Simulator, liveMarket) });
    await settle();
    assert.equal(root().querySelector(".sim-performance"), null);
    assert.equal(button("Refresh simulation").disabled, true);
    assert.match(root().querySelector(".sim-empty").textContent, /Loading live ATM curve/);
    assert.equal(root().querySelector("progress").value, 1);
    assert.equal(root().querySelector("progress").max, 6);
    assert.match(root().querySelector(".sim-empty").textContent, /1 \/ 6 quotes checked/);
    liveMarket.marketCooldown = 10;
    await nextTick();
    assert.match(root().querySelector(".sim-empty").textContent, /retrying in 10s/);
    liveMarket.marketCooldown = 0;
    liveMarket.liveCurve = [{ seconds: 86400, iv: 0.7, strike: 90000, ready: true }];
    liveMarket.marketProgress = { checked: 4, total: 6 };
    await settle();
    assert.ok(
      root().querySelector(".sim-performance"),
      "a waiting tab runs from the ATM curve before wing quote loading finishes",
    );
    const earlyPath = root().querySelector(".index-price-path").getAttribute("d");
    liveMarket.liveCurve = [{ seconds: 86400, iv: 0.7, strike: 90000, ready: true }];
    liveMarket.marketLoading = false;
    await settle();
    assert.equal(root().querySelector(".index-price-path").getAttribute("d"), earlyPath,
      "background quote completion does not reset the captured simulation");
    const customQuantity = root().querySelector(".leg-row .qty-input");
    customQuantity.value = "2";
    customQuantity.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle();
    const beforeRefresh = root()
      .querySelector(".index-price-path")
      .getAttribute("d");
    liveMarket.marketLoading = true;
    await settle();
    assert.equal(
      root().querySelector(".index-price-path").getAttribute("d"),
      beforeRefresh,
      "the previous result stays visible while refreshing the market",
    );
    liveMarket.marketLoading = false;
    liveMarket.asOf += 1;
    liveMarket.liveCurve = [{ seconds: 86400 - 1, iv: 0.65, strike: 90000 }];
    await settle();
    const afterRefresh = root()
      .querySelector(".index-price-path")
      .getAttribute("d");
    assert.notEqual(
      afterRefresh,
      beforeRefresh,
      "refresh automatically generates a new path",
    );
    assert.equal(root().querySelector(".leg-row .qty-input").value, "2", "refresh preserves the edited position");
    const beforeReload = root()
      .querySelector(".index-price-path")
      .getAttribute("d");
    app.unmount();
    mount(Simulator, liveMarket);
    await settle();
    assert.notEqual(
      root().querySelector(".index-price-path").getAttribute("d"),
      beforeReload,
      "reloading with the same market data generates a fresh default run",
    );
    app.unmount();

    const now = Date.now() / 1000;
    const partialMarket = reactive({ ...liveMarket,
      instruments: chain(liveMarket.asOf, [1, 7]),
      liveCurve: [{ seconds: 86400, iv: 0.7, ready: false }],
      marketLoading: true,
    });
    mount({ setup: () => () => h(Simulator, partialMarket) });
    await settle();
    assert.equal(root().querySelector(".sim-performance"), null, "a partial curve waits while more maturities can arrive");
    assert.match(root().querySelector(".sim-empty").textContent, /0 \/ 2 ATM expiries ready/);
    partialMarket.marketLoading = false;
    await settle();
    assert.ok(root().querySelector(".sim-performance"), "completed snapshots with unavailable maturities still use the available-curve fallback");
    app.unmount();

    const expiry = now + 86400;
    let releaseWings, releaseHistory, usableTickers = 0, chainRequests = 0;
    const wingsPending = new Promise(resolve => { releaseWings = resolve; });
    const historyPending = new Promise(resolve => { releaseHistory = resolve; });
    t.mock.method(globalThis, "fetch", async (input) => {
      const url = new URL(input, "http://localhost/");
      let result;
      if (url.pathname.endsWith("/instruments")) {
        chainRequests++;
        result = [90000, 92000, 94000].flatMap((strike) =>
          ["call", "put"].map((type) => ({
            instrument_name: `BTC-TEST-${strike}-${type}`,
            type: "option",
            underlying: "BTCUSD",
            strike_price: strike,
            expiration_timestamp: expiry,
            option_type: type,
          })),
        );
      } else if (url.pathname.endsWith("/ticker")) {
        if (url.searchParams.get("instrument_name").includes("94000")) await wingsPending;
        else usableTickers++;
        result = { iv: 0.6, index: 91000, mark_timestamp: Date.now() / 1000 };
      } else if (
        url.pathname.endsWith("/index_price_historical_data") ||
        url.pathname.endsWith("/mark_price_historical_data")
      ) {
        await historyPending;
        result = { no_data: true };
      } else if (url.pathname.includes("history-cache")) {
        return { ok: false, status: 404 };
      } else {
        throw new Error(`Unexpected API call: ${input}`);
      }
      return { ok: true, json: async () => ({ result }) };
    });
    const appFile = await compile(
      fileURLToPath(new URL("./App.vue", import.meta.url)),
    );
    const { default: App } = await import(pathToFileURL(appFile).href);
    mount(App);
    for (let i = 0; i < 400 && usableTickers < 4; i++) await settle();
    await settle();
    assert.equal(usableTickers, 4, "both ATM brackets are already loaded on the curve tab");
    assert.ok(root().querySelector(".topBar [role=tablist]"), "workspace tabs live in the top bar");
    button("Simulate").click();
    await nextTick();
    assert.equal(root().querySelector("#panel-curve").style.display, "none");
    await settle();
    assert.ok(root().querySelector(".sim-performance"), "entering simulation reuses the curve while wing quotes and history remain blocked");
    assert.ok(button("Restart fetch"), "background market/history loading is still in flight");
    assert.equal(chainRequests, 1, "opening simulation does not refetch the option chain");
    const resultText = root().querySelector(".performance-readout").textContent;
    const resultPath = root()
      .querySelector(".index-price-path")
      .getAttribute("d");
    root().querySelector("#tab-curve").click();
    await nextTick();
    assert.equal(root().querySelector("#panel-simulate").style.display, "none");
    button("Simulate").click();
    await nextTick();
    assert.equal(root().querySelector(".performance-readout").textContent, resultText);
    assert.equal(
      root().querySelector(".index-price-path").getAttribute("d"),
      resultPath,
    );
    releaseWings();
    releaseHistory();
    await settle();
    button("ETH").click();
    await settle();
    assert.equal(
      root().querySelector(".sim-performance"),
      null,
      "changing asset cannot mislabel BTC results as ETH",
    );
    assert.match(
      root().querySelector(".sim-empty").textContent,
      /No live ETH option expiries returned.*Use Refresh above to retry/,
    );
    assert.equal(button("Refresh simulation").disabled, true);
    app.unmount();

    const panelFile = await compile(fileURLToPath(new URL("../../../lib/components/SettingsSidePanel.vue", import.meta.url)));
    const controlsFile = await compile(fileURLToPath(new URL("../../../lib/components/DeltaHedgeControls.vue", import.meta.url)));
    const toggleFile = await compile(fileURLToPath(new URL("../../../lib/components/DeltaHedgeToggle.vue", import.meta.url)));
    const { default: SettingsSidePanel } = await import(pathToFileURL(panelFile).href);
    const { default: DeltaHedgeControls } = await import(pathToFileURL(controlsFile).href);
    const { default: DeltaHedgeToggle } = await import(pathToFileURL(toggleFile).href);
    const fixture = reactive({ policy: { enabled: true, threshold: .05, tolerance: .15, period: 1800,
      timing: "timer", hedgeBps: 1, entry: "neutralize", exit: "unwind" } });
    let mainClicks = 0;
    mount({ setup: () => () => h("div", { class: "settings-workspace" }, [
      h("main", [
        h("button", { class: "main-action", onClick: () => { mainClicks++; } }, h("span", "Main action")),
        h("input", { class: "history-window-control", type: "range", min: 100, max: 10000 }),
        h(DeltaHedgeToggle, { modelValue: fixture.policy.enabled,
          "onUpdate:modelValue": value => { fixture.policy = { ...fixture.policy, enabled: value }; } }),
        h(SettingsSidePanel, { target: "#test-settings-dock", title: "Hedge settings" }, {
          "header-actions": () => h(DeltaHedgeToggle, { modelValue: fixture.policy.enabled,
            "onUpdate:modelValue": value => { fixture.policy = { ...fixture.policy, enabled: value }; } }),
          default: () => h(DeltaHedgeControls, { modelValue: fixture.policy, showToggle: false,
            "onUpdate:modelValue": value => { fixture.policy = value; } }),
        }),
      ]),
      h("div", { id: "test-settings-dock", class: "settings-dock" }),
    ]) });
    const toggle = root().querySelector('[role="switch"][aria-label="Delta hedge"]');
    toggle.click(); await nextTick();
    assert.equal(fixture.policy.enabled, false, "hedging can be disabled with settings closed");
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    assert.equal(window.document.querySelector(".settings-side-panel"), null, "the hedge switch does not open settings");
    toggle.click(); await nextTick();
    const trigger = root().querySelector(".settings-panel-trigger");
    assert.equal(trigger.textContent.trim(), "Configure");
    assert.equal(trigger.getAttribute("aria-label"), "Configure hedge settings");
    assert.equal(trigger.title, "Open hedge settings side panel");
    trigger.focus(); trigger.click();
    await settle();
    let dialog = window.document.querySelector(".settings-side-panel");
    assert.equal(dialog.parentElement.id, "test-settings-dock", "the panel occupies its own layout column");
    assert.equal(dialog.getAttribute("aria-modal"), null, "the dock is nonmodal");
    const panelToggle = dialog.querySelector('header [role="switch"]');
    assert.ok(panelToggle, "hedging can also be toggled beside the settings title");
    assert.equal(dialog.querySelectorAll('[role="switch"]').length, 1, "the toggle appears only in the header");
    const explanation = dialog.querySelector("details.hedge-method");
    assert.equal(explanation.open, false, "definitions start collapsed below the configuration");
    assert.ok(explanation.contains(dialog.querySelector(".hedge-explanation")));
    assert.ok(explanation.contains(dialog.querySelector(".hedge-source")), "the API reference stays inside the explanation");
    assert.equal(panelToggle.checked, true);
    assert.equal(window.document.querySelector(".settings-panel-backdrop"), null);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(trigger.title, "Close hedge settings side panel");
    assert.equal(window.document.body.style.overflow, "", "opening keeps page scrolling available");
    assert.equal(window.document.activeElement.getAttribute("aria-label"), "Close settings");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
    dialog.getBoundingClientRect = () => ({ width: parseFloat(dialog.style.getPropertyValue("--resized-settings-panel-width")) || 420 });
    window.dispatchEvent(new window.Event("resize"));
    const divider = dialog.querySelector('[role="separator"]');
    let capturedPointer = null;
    divider.setPointerCapture = id => { capturedPointer = id; };
    divider.hasPointerCapture = id => capturedPointer === id;
    divider.releasePointerCapture = () => { capturedPointer = null; };
    const pointer = (type, x) => divider.dispatchEvent(new window.PointerEvent(type,
      { pointerId: 1, button: 0, isPrimary: true, clientX: x, bubbles: true, cancelable: true }));
    pointer("pointerdown", 800); pointer("pointermove", 600); pointer("pointerup", 600);
    await nextTick();
    assert.equal(divider.getAttribute("aria-valuenow"), "620", "dragging left widens the right-hand panel");
    assert.equal(capturedPointer, null, "releasing the divider releases pointer capture");
    divider.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await nextTick();
    assert.equal(divider.getAttribute("aria-valuenow"), "600", "the divider can be resized with the keyboard");
    pointer("pointerdown", 600); pointer("pointermove", -2000);
    await nextTick();
    assert.equal(divider.getAttribute("aria-valuenow"), "880", "resizing leaves at least 320 pixels for the main content");
    pointer("pointermove", 4000); pointer("pointercancel", 4000);
    await nextTick();
    assert.equal(divider.getAttribute("aria-valuenow"), "280", "the panel cannot become too narrow to use");
    assert.equal(dialog.classList.contains("is-resizing"), false, "a cancelled drag releases resize state");
    divider.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }));
    await nextTick();
    assert.equal(divider.getAttribute("aria-valuenow"), "330");
    const tabEvent = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    dialog.dispatchEvent(tabEvent);
    assert.equal(tabEvent.defaultPrevented, false, "keyboard focus can leave the dock");
    dialog.querySelector("h2").click();
    await nextTick();
    assert.ok(window.document.querySelector(".settings-side-panel"), "clicking inside settings keeps the panel open");
    assert.equal(dialog.querySelectorAll("select").length, 0, "hedge settings use visible choices instead of dropdowns");
    assert.equal(dialog.querySelectorAll('input[type="range"]').length, 3, "bands and hedge frequency use sliders");
    assert.equal(dialog.querySelector('input[value="scheduled"]'), null, "timing has one resettable policy");
    assert.equal(dialog.querySelector('input[value="policy"]'), null, "entry is always neutralized immediately");
    const tolerance = dialog.querySelectorAll('input[type="range"]')[1];
    tolerance.value = "20"; tolerance.dispatchEvent(new window.Event("input", { bubbles: true }));
    await nextTick();
    assert.equal(fixture.policy.tolerance, .2);
    assert.equal(dialog.querySelectorAll(".hedge-slider output")[0].textContent, "0.05");
    assert.equal(dialog.querySelectorAll(".hedge-slider output")[1].textContent, "0.20");
    assert.equal(fixture.policy.timing, "timer");
    assert.equal(fixture.policy.entry, "neutralize");
    const threshold = dialog.querySelectorAll('input[type="range"]')[0];
    tolerance.value = "1"; tolerance.dispatchEvent(new window.Event("input", { bubbles: true }));
    await nextTick();
    assert.equal(fixture.policy.tolerance, .05, "positive tolerance cannot be dragged below threshold");
    assert.equal(tolerance.value, "5", "the slider snaps back to the allowed minimum");
    threshold.value = "30"; threshold.dispatchEvent(new window.Event("input", { bubbles: true }));
    await nextTick();
    assert.equal(fixture.policy.tolerance, .3, "raising threshold lifts active tolerance in the same update");
    tolerance.value = "0"; tolerance.dispatchEvent(new window.Event("input", { bubbles: true }));
    await nextTick();
    assert.equal(fixture.policy.tolerance, 0, "zero still disables the tolerance override");
    threshold.value = "5"; threshold.dispatchEvent(new window.Event("input", { bubbles: true }));
    await nextTick();
    assert.equal(fixture.policy.tolerance, 0, "threshold edits preserve the disabled override");
    tolerance.value = "20"; tolerance.dispatchEvent(new window.Event("input", { bubbles: true }));
    await nextTick();
    assert.equal(dialog.querySelector(".hedge-error"), null);
    const period = dialog.querySelectorAll('input[type="range"]')[2];
    assert.equal(period.min, "0");
    assert.equal(period.max, "11", "the slider has twelve distinct timing presets");
    for (const [step, seconds, text] of [
      [0, 300, "5 minutes"], [1, 600, "10 minutes"], [2, 900, "15 minutes"], [3, 1800, "30 minutes"],
      [4, 3600, "1 hour"], [5, 7200, "2 hours"], [6, 10800, "3 hours"], [7, 14400, "4 hours"],
      [8, 21600, "6 hours"], [9, 28800, "8 hours"], [10, 43200, "12 hours"], [11, 86400, "24 hours"],
      [4, 3600, "1 hour"], [3, 1800, "30 minutes"],
    ]) {
      period.value = String(step); period.dispatchEvent(new window.Event("input", { bubbles: true }));
      await nextTick();
      assert.equal(fixture.policy.period, seconds, "each stop selects its exact timing preset in seconds");
      assert.equal(period.value, String(step));
      assert.equal(period.getAttribute("aria-valuetext"), text);
      assert.equal(period.getAttribute("aria-label"), seconds < 3600 ? "Period · minutes" : "Period · hours");
      assert.ok(dialog.querySelector(".hedge-explanation").textContent.includes(`${text}. Returning inside resets the timer`));
    }
    panelToggle.click(); await nextTick();
    assert.equal(fixture.policy.enabled, false);
    assert.equal(toggle.checked, false, "the settings toggle updates the external toggle");
    assert.ok(dialog.querySelector("fieldset").disabled, "disabling hedging updates the open settings");
    assert.equal(panelToggle.disabled, false, "hedging can be re-enabled while its fields are disabled");
    assert.ok(window.document.querySelector(".settings-side-panel"), "toggling inside settings keeps the pane open");
    panelToggle.click(); await nextTick();
    assert.equal(fixture.policy.enabled, true);
    assert.equal(toggle.checked, true);
    assert.equal(dialog.querySelector("fieldset").disabled, false);
    assert.equal(fixture.policy.tolerance, .2, "switching hedging off and on preserves the policy");
    pointer("pointerdown", 600);
    dialog.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    assert.equal(window.document.querySelector(".settings-side-panel"), null);
    assert.equal(window.document.body.style.overflow, "");
    assert.equal(capturedPointer, null, "closing during a drag releases pointer capture");
    assert.equal(window.document.activeElement, trigger, "closing returns focus to the opener");
    trigger.click(); await settle();
    dialog = window.document.querySelector(".settings-side-panel");
    assert.equal(dialog.querySelector('[role="separator"]').getAttribute("aria-valuenow"), "330", "reopening retains the chosen width");
    assert.equal(dialog.querySelectorAll('input[type="range"]')[1].value, "20", "reopening preserves settings");
    const mainAction = root().querySelector(".main-action");
    mainAction.focus(); mainAction.querySelector("span").click(); await settle();
    assert.equal(mainClicks, 1, "the outside click still activates its target");
    assert.ok(window.document.querySelector(".settings-side-panel"), "clicking a button's child keeps settings open");
    assert.equal(window.document.activeElement, mainAction, "using another control preserves its focus");
    root().querySelector(".history-window-control").click(); await settle();
    assert.ok(window.document.querySelector(".settings-side-panel"), "using a time-window slider keeps settings open");
    root().querySelector("main").click(); await settle();
    assert.ok(window.document.querySelector(".settings-side-panel"), "a single click on blank space keeps settings open");
    dialog.querySelector("h2").dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    await settle();
    assert.ok(window.document.querySelector(".settings-side-panel"), "double-clicking inside settings keeps the pane open");
    root().querySelector("main").dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    await settle();
    assert.equal(window.document.querySelector(".settings-side-panel"), null, "double-clicking outside closes settings");
    trigger.click(); await settle();
    assert.ok(window.document.querySelector(".settings-side-panel"), "the opener is excluded from outside dismissal");
    trigger.click(); await settle();
    assert.equal(window.document.querySelector(".settings-side-panel"), null, "the opener can still toggle settings closed");
    trigger.click(); await settle();
    toggle.click(); await settle();
    assert.equal(fixture.policy.enabled, false);
    assert.ok(window.document.querySelector(".settings-side-panel"), "the separate hedge switch keeps settings open");
    assert.ok(window.document.querySelector(".settings-side-panel fieldset").disabled);
    assert.equal(window.document.querySelector('.settings-side-panel [role="switch"]').checked, false, "the external toggle updates the settings toggle");
    toggle.click(); await settle();
    assert.equal(fixture.policy.enabled, true);
    assert.ok(window.document.querySelector(".settings-side-panel"), "switching hedging on keeps settings open");
    dialog = window.document.querySelector(".settings-side-panel");
    assert.equal(dialog.querySelectorAll('input[type="range"]')[1].value, "20", "outside dismissal preserves settings");
    assert.equal(dialog.querySelector('[role="separator"]').getAttribute("aria-valuenow"), "330", "outside dismissal preserves panel width");
    window.document.querySelector('[aria-label="Close settings"]').click(); await settle();
    assert.equal(window.document.querySelector(".settings-side-panel"), null, "the close button works");
    assert.equal(window.document.querySelector("#test-settings-dock").children.length, 0, "closing releases the dock column");
    app.unmount();

    const comboChartFile = await compile(fileURLToPath(new URL("../../combo-pnl/src/components/Chart.vue", import.meta.url)));
    const { default: ComboChart } = await import(pathToFileURL(comboChartFile).href);
    const start = Date.parse("2026-11-04T09:00:00Z") / 1000;
    const minutes = Array.from({ length: 241 }, (_, i) => ({ ts: start + i * 60,
      index_price_close: 100 + i / 10, mark_price_close: 10 + i / 100 }));
    const chartState = reactive({ range: null, resolution: "900" });
    mount({ setup: () => () => h(ComboChart, {
      indexData: minutes.filter((_, i) => i % 60 === 0), comboData: minutes,
      observationData: minutes, timeRangeTs: chartState.range, resolutionKey: chartState.resolution,
      "onUpdate:timeRangeTs": value => { chartState.range = value; },
    }) });
    await nextTick();
    const chartSvg = root().querySelector("svg");
    chartSvg.createSVGPoint = undefined; // Use d3's bounding-rectangle pointer path.
    const brush = root().querySelector(".brush");
    brush.getBoundingClientRect = () => ({ left: 0, top: 0 });
    Object.defineProperties(brush, { clientLeft: { value: 0 }, clientTop: { value: 0 } });
    const xAt = minute => 1088 * minute / 240 + .5;
    const mouse = (target, type, minute) => target.dispatchEvent(new window.MouseEvent(type,
      { view: window, clientX: xAt(minute), clientY: 50, button: 0, bubbles: true, cancelable: true }));
    const labels = () => [...root().querySelectorAll(".trade-boundary-label")].map(node => node.firstChild.textContent);
    mouse(brush.querySelector(".overlay"), "mousedown", 30);
    mouse(window, "mousemove", 91);
    assert.deepEqual(labels(), ["Entry · 09:31 UTC · $103.10", "Exit · 10:31 UTC · $109.10"], "drag previews snap to minute observations, independent of coarse chart points");
    assert.ok([...root().querySelectorAll(".trade-boundary-label")].every(node => Number(node.getAttribute("y")) < 0), "entry and exit labels sit above the plot and selection band");
    assert.equal(chartState.range, null, "live time labels do not commit the trade while dragging");
    mouse(window, "mousemove", 151);
    assert.deepEqual(labels(), ["Entry · 09:31 UTC · $103.10", "Exit · 11:31 UTC · $115.10"], "the exit time updates before the mouse is released");
    mouse(window, "mouseup", 151);
    await nextTick();
    assert.deepEqual(chartState.range, [start + 31 * 60, start + 151 * 60]);
    assert.deepEqual(labels(), ["Entry · 09:31 UTC · $103.10", "Exit · 11:31 UTC · $115.10"]);
    assert.match(root().querySelector(".trade-boundary-label title").textContent, /04 Nov 26 09:31 UTC/);
    chartState.resolution = "3600"; await nextTick();
    assert.deepEqual(labels(), ["Entry · 09:31 UTC · $103.10", "Exit · 11:31 UTC · $115.10"], "changing chart resolution preserves the minute entry/exit prices and times");
    assert.deepEqual(errors, []);
  } finally {
    app?.unmount();
    await window.happyDOM.close();
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
