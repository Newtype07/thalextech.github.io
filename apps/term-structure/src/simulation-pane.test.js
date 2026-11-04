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
import { Worker as NodeWorker } from "node:worker_threads";

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

test("performance UI runs automatically with fresh paths, inspects, exports, and preserves results across tabs", async (t) => {
  const directory = await mkdtemp(
    fileURLToPath(new URL("../.simulation-test-", import.meta.url)),
  );
  const window = new Window({ url: "http://localhost/" });
  const workers = new Set();
  // Run the actual browser worker module in a Node thread, adapting only messaging.
  class BrowserWorker {
    constructor(url) {
      this.worker = new NodeWorker(`
        const { parentPort } = require('node:worker_threads');
        globalThis.self = { postMessage: data => parentPort.postMessage(data) };
        import(${JSON.stringify(url.href)}).then(() => {
          parentPort.on('message', data => self.onmessage({ data }));
        });
      `, { eval: true });
      workers.add(this);
      this.worker.on("message", data => this.onmessage?.({ data }));
      this.worker.on("error", error => this.onerror?.({ message: error.message }));
    }
    postMessage(data) { this.worker.postMessage(data); }
    terminate() { workers.delete(this); this.worker.terminate(); }
  }
  const values = {
    window,
    WebSocket: undefined,
    document: window.document,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    Worker: BrowserWorker,
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
      element.value = String(value);
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
      "ready market data starts a default run without submitting the form",
    );
    assert.equal(root().querySelectorAll(".leg-row").length, 2);
    assert.match(root().querySelector(".combination-heading h1").textContent, /^Bitcoin · /);
    assert.equal(root().querySelector('[aria-label="Combination maturity"]').textContent.trim(), builderExpiry(1793700000 + 7 * 86400));
    assert.equal(root().querySelectorAll('[aria-label="Option expiry"]').length, 0);
    assert.ok(root().querySelector('[aria-label="Edit maturities per leg"]'));
    for (const row of root().querySelectorAll(".leg-row")) {
      assert.match(row.querySelector(".side-pill").getAttribute("aria-label"), /^Sell leg/);
      assert.equal(row.querySelector(".qty-input").value, "1");
      assert.equal(row.querySelector('[aria-label="Option strike"]').textContent.trim(), "90,000");
    }
    assert.equal(input("Realized / forward volatility").value, "100");
    assert.ok(root().querySelector('[role="group"][aria-label="Simulate until"]'));
    assert.equal(button("First expiry").getAttribute("aria-pressed"), "true");
    assert.equal(button("Last expiry").getAttribute("aria-pressed"), "false");
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
    const sidebar = root().querySelector('aside[aria-label="Hedge settings"]');
    assert.ok(sidebar);
    assert.notEqual(sidebar.style.display, "none", "hedge settings are open by default");
    assert.match(root().querySelector(".sim-timer-help").textContent, /resets the timer/);
    assert.equal(button("Update market snapshot"), undefined);
    assert.doesNotMatch(root().textContent, /seed/i);
    const beforeHiding = pathSeed;
    button("Hide hedge settings").click();
    await settle();
    assert.equal(sidebar.style.display, "none");
    assert.ok(root().querySelector(".sim-layout-collapsed"));
    assert.equal(button("Show hedge settings").getAttribute("aria-expanded"), "false");
    button("Show hedge settings").click();
    await settle();
    assert.notEqual(sidebar.style.display, "none");
    assert.equal(pathSeed, beforeHiding, "hiding and showing settings preserves the run");
    assert.match(
      root().querySelector(".sim-source").textContent,
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
      root().querySelector(".sim-trade-facts").textContent,
      /\$91,000.00/,
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
    assert.equal(
      root().querySelectorAll(".pnl-chart path[data-series]").length,
      3,
    );
    assert.match(
      root().querySelector(".pnl-heading").textContent,
      /2 option legs/,
    );
    assert.equal(
      root().querySelectorAll(".pnl-key .performance-value").length,
      3,
    );
    assert.equal(
      root().querySelectorAll(".index-chart .index-price-path").length,
      1,
    );
    const indexChart = root().querySelector(".index-chart");
    const pnlChart = root().querySelector(".pnl-chart");
    assert.ok(
      pnlChart.compareDocumentPosition(indexChart) &
        window.Node.DOCUMENT_POSITION_FOLLOWING,
      "P&L is above the index chart",
    );
    assert.match(
      root().querySelector(".index-heading").textContent,
      /annual drift 0.00%/,
    );
    const tradeDots = root().querySelectorAll(".index-chart .hedge-trade-dot");
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
    assert.match(
      root().querySelector(".index-heading").textContent,
      /annual drift 20.00%/,
    );
    assert.notEqual(
      root().querySelector(".index-price").textContent,
      noDriftPrice,
    );
    await set("Annual drift", -20);
    await settle();
    assert.match(
      root().querySelector(".index-heading").textContent,
      /annual drift -20.00%/,
    );
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
    const svg = root().querySelector(".index-chart");
    const pnlSvg = root().querySelector(".pnl-chart");
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
    assert.equal(root().querySelector(".index-heading .index-time").textContent, "Day 0.000");
    assert.ok(root().querySelector(".index-cursor"));
    assert.ok(root().querySelector(".performance-cursor"));

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
    assert.match(
      root().querySelector('[role="alert"]').textContent,
      /Tolerance/,
    );
    assert.ok(
      root().querySelector(".sim-performance"),
      "invalid settings preserve the last good result",
    );
    await set("Tolerance", 0.15);
    await settle();
    assert.equal(root().querySelector('[role="alert"]'), null);
    // Change modes while a real worker is running; stale batches must not publish.
    button("100 runs").click();
    for (let i = 0; i < 200 && !workers.size; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      await nextTick();
    }
    assert.equal(workers.size, 1);
    assert.ok(root().querySelector(".sim-progress"));
    button("Single run").click();
    await settle();
    assert.equal(workers.size, 0, "switching to single run terminates the batch worker");
    assert.ok(root().querySelector(".sim-performance"));
    assert.equal(root().querySelector(".sim-ensemble"), null);
    button("100 runs").click();
    await settle();
    for (let i = 0; i < 100 && root().querySelector(".sim-progress"); i++) await settle();
    assert.equal(root().querySelector('[role="alert"]'), null);
    assert.equal(root().querySelector(".sim-progress"), null);
    assert.equal(root().querySelectorAll(".ensemble-path").length, 100);
    assert.equal(root().querySelectorAll(".ensemble-median").length, 1);
    assert.equal(root().querySelector(".sim-performance"), null);
    assert.equal(workers.size, 0, "completed workers are released");
    const ensembleChart = root().querySelector(".ensemble-chart");
    ensembleChart.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await nextTick();
    assert.match(root().querySelector(".ensemble-actions").textContent, /Day 0.000/);
    assert.ok(root().querySelector(".ensemble-cursor"));
    ensembleChart.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    assert.match(root().querySelector(".ensemble-actions").textContent, /At exit/);
    button("Export CSV").click();
    await nextTick();
    assert.equal(downloads.at(-1), "BTC-position-100-runs.csv");
    const ensembleCsv = (await blobs.at(-1).text()).trim().split("\n");
    assert.equal(ensembleCsv[0], "run,elapsedSeconds,totalPnl");
    const exported = ensembleCsv.slice(1).map(row => row.split(","));
    const medians = exported.filter(row => row[0] === "median");
    assert.equal(medians.length, 1200);
    assert.equal(exported.length, 1200 * 101);
    const terminal = exported.filter(row => row[0] !== "median" && row[1] === medians.at(-1)[1])
      .map(row => Number(row[2])).sort((a, b) => a - b);
    assert.equal(Number(medians.at(-1)[2]), (terminal[49] + terminal[50]) / 2);
    const oldMedian = root().querySelector(".ensemble-median").getAttribute("d");
    button("Refresh simulation").click();
    await settle();
    for (let i = 0; i < 100 && root().querySelector(".sim-progress"); i++) await settle();
    assert.notEqual(root().querySelector(".ensemble-median").getAttribute("d"), oldMedian);
    button("Single run").click();
    await settle();
    assert.ok(root().querySelector(".sim-performance"));
    assert.equal(root().querySelectorAll(".leg-row").length, 2, "mode switches preserve legs");
    for (const [label, value] of [
      ["Period", 60],
      ["Timer behaviour", "scheduled"],
      ["Hedge cost", 2],
      ["Option cost", 2],
    ]) {
      const previousPath = root().querySelector(".index-price-path").getAttribute("d");
      await set(label, value);
      await settle();
      assert.notEqual(
        root().querySelector(".index-price-path").getAttribute("d"),
        previousPath,
        `${label} automatically reruns the simulation`,
      );
      assert.equal(root().querySelector('[role="alert"]'), null);
    }
    assert.match(root().querySelector(".sim-timer-help").textContent, /Check net delta every 60 minutes/);
    const beforeTyping = pathSeed;
    await set("Threshold", 0.11);
    await set("Threshold", 0.12);
    await settle();
    assert.equal(pathSeed, beforeTyping + 1, "rapid edits are combined into one run");
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
    assert.match(root().querySelector(".pnl-heading").textContent, /exit at first expiry/);
    assert.match(root().querySelector(".sim-trade-facts").textContent, /later legs closed at model marks/);
    assert.equal(root().querySelector(".performance-time").textContent, "At first expiry");
    assert.equal(button("First expiry").getAttribute("aria-pressed"), "true");
    assert.equal(button("Last expiry").getAttribute("aria-pressed"), "false");
    const validCurve = initialMarket.liveCurve;
    initialMarket.liveCurve = [{ seconds: 86400, iv: 0.7, strike: 90000 }];
    await settle();
    assert.match(root().querySelector('[role="status"]').textContent, /exceeds the curve/);
    assert.ok(button("Last expiry"), "exit controls stay visible when a calendar cannot be valued");
    initialMarket.liveCurve = validCurve;
    await settle();
    button("Last expiry").click();
    await settle();
    assert.equal(button("Last expiry").getAttribute("aria-pressed"), "true");
    assert.equal(root().querySelector(".performance-time").textContent, "At last expiry");
    assert.match(root().querySelector(".pnl-heading").textContent, /exit at last expiry/);
    assert.match(root().querySelector(".pnl-heading .performance-subtitle").textContent, /7.00 days/);
    assert.match(root().querySelector(".sim-trade-facts").textContent, /earlier legs cash-settle/);
    assert.equal(root().querySelector('[role="alert"]'), null);
    button("Export CSV").click();
    await nextTick();
    const lastExpiryRows = (await blobs.at(-1).text()).trim().split("\n").slice(1)
      .map(row => row.split(",").map(Number));
    assert.equal(lastExpiryRows.at(-1)[0], 7 * 86400, "last-expiry CSV spans the far leg's maturity");
    button("First expiry").click();
    await settle();
    assert.equal(root().querySelector(".performance-time").textContent, "At first expiry");
    assert.match(root().querySelector(".pnl-heading .performance-subtitle").textContent, /1.00 days/);
    assert.equal(root().querySelectorAll(".leg-row").length, 2, "exit changes preserve the position");
    assert.equal(root().querySelector(".performance-summary"), null);
    const calendarPath = root().querySelector(".index-price-path").getAttribute("d");
    const quantity = root().querySelectorAll(".leg-row")[1].querySelector(".qty-input");
    quantity.value = "2";
    quantity.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle();
    assert.notEqual(root().querySelector(".index-price-path").getAttribute("d"), calendarPath);
    assert.equal(root().querySelector('[role="alert"]'), null);
    for (const count of [3, 4]) {
      button("+ Add leg").click();
      await settle();
      assert.equal(root().querySelectorAll(".leg-row").length, count);
      assert.match(root().querySelector(".pnl-heading").textContent, new RegExp(`${count} option legs`));
    }
    assert.equal(button("+ Add leg"), undefined, "the shared builder supports four legs");
    root().querySelectorAll(".remove-btn")[3].click();
    await settle();
    assert.match(root().querySelector(".pnl-heading").textContent, /3 option legs/);
    for (const remove of root().querySelectorAll(".remove-btn")) {
      remove.click();
      await nextTick();
    }
    await settle();
    assert.match(root().querySelector('[role="status"]').textContent, /Add an option leg/);
    assert.equal(root().querySelectorAll(".leg-row").length, 0);
    button("+ Add leg").click();
    await settle();
    assert.match(root().querySelector(".pnl-heading").textContent, /1 option leg/);
    assert.deepEqual(errors, []);
    app.unmount();

    const liveMarket = reactive({
      asset: "BTC",
      instruments: chain(1793700000, [1]),
      liveSpot: 91000,
      asOf: 1793700000,
      liveCurve: [{ seconds: 86400, iv: 0.7, strike: 90000 }],
      marketLoading: true,
    });
    mount({ setup: () => () => h(Simulator, liveMarket) });
    await settle();
    assert.equal(root().querySelector(".sim-performance"), null);
    assert.equal(button("Refresh simulation").disabled, true);
    liveMarket.marketLoading = false;
    await settle();
    assert.ok(
      root().querySelector(".sim-performance"),
      "a waiting tab runs automatically when live data finishes loading",
    );
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
    const expiry = now + 86400;
    t.mock.method(globalThis, "fetch", async (input) => {
      const url = new URL(input, "http://localhost/");
      let result;
      if (url.pathname.endsWith("/instruments")) {
        result = [90000, 92000].flatMap((strike) =>
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
        result = { iv: 0.6, index: 91000, mark_timestamp: Date.now() / 1000 };
      } else if (
        url.pathname.endsWith("/index_price_historical_data") ||
        url.pathname.endsWith("/mark_price_historical_data")
      ) {
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
    await settle();
    button("Simulate").click();
    await nextTick();
    assert.equal(root().querySelector("#panel-curve").style.display, "none");
    for (let i = 0; i < 400 && !root().querySelector(".sim-performance"); i++)
      await settle();
    assert.ok(root().querySelector(".sim-performance"));
    const resultText = root().querySelector(".pnl-heading").textContent;
    const resultPath = root()
      .querySelector(".index-price-path")
      .getAttribute("d");
    root().querySelector("#tab-curve").click();
    await nextTick();
    assert.equal(root().querySelector("#panel-simulate").style.display, "none");
    button("Simulate").click();
    await nextTick();
    assert.equal(root().querySelector(".pnl-heading").textContent, resultText);
    assert.equal(
      root().querySelector(".index-price-path").getAttribute("d"),
      resultPath,
    );
    button("ETH").click();
    await settle();
    assert.equal(
      root().querySelector(".sim-performance"),
      null,
      "changing asset cannot mislabel BTC results as ETH",
    );
    assert.match(
      root().querySelector(".sim-source").textContent,
      /Waiting for market/,
    );
    assert.equal(button("Refresh simulation").disabled, true);
    assert.deepEqual(errors, []);
  } finally {
    app?.unmount();
    for (const worker of workers) worker.terminate();
    await window.happyDOM.close();
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
