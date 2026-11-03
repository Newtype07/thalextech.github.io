import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, compileScript } from "@vue/compiler-sfc";
import { Window } from "happy-dom";

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
    for (const match of [...content.matchAll(/from\s+(["'])(\.[^"']+)\1/g)]) {
      const dependency = resolve(dirname(filename), match[2]);
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

test("performance UI selects a straddle, shows three net P&L curves, inspects, exports, and preserves results across tabs", async (t) => {
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
    const compile = await compiler(directory);
    const file = await compile(
      fileURLToPath(
        new URL("./components/StraddleSimulator.vue", import.meta.url),
      ),
    );
    const { createApp, nextTick } = await import("vue");
    const { default: Simulator } = await import(pathToFileURL(file).href);
    const errors = [];
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
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
        (node) => node.textContent.trim() === text,
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
    const submit = async () => {
      root()
        .querySelector("form")
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        );
      await settle();
    };
    mount(Simulator, {
      asset: "BTC",
      liveSpot: 91000,
      asOf: 1793700000,
      liveCurve: [
        { seconds: 86400, iv: 0.7, strike: 90000 },
        { seconds: 7 * 86400, iv: 0.6, strike: 92000 },
      ],
    });
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
    ])
      assert.equal(input(removed), undefined);
    assert.match(
      root().querySelector(".sim-trade-facts").textContent,
      /\$91,000.00/,
    );
    assert.match(
      root().querySelector(".sim-trade-facts").textContent,
      /\$92,000.00/,
    );
    await set("Option maturity", 1);
    assert.match(
      root().querySelector(".sim-trade-facts").textContent,
      /\$90,000.00/,
    );
    assert.equal(input("Annual drift").value, "0");
    const ratio = input("Realized / forward volatility");
    assert.equal(ratio.type, "range");
    assert.equal(ratio.min, "50");
    assert.equal(ratio.max, "200");
    await set("Realized / forward volatility", 50);
    await submit();
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
    assert.equal(root().querySelectorAll(".pnl-chart path").length, 3);
    assert.match(
      root().querySelector(".pnl-heading").textContent,
      /1 BTC per leg/,
    );
    assert.equal(
      root().querySelectorAll(".performance-legend .performance-value").length,
      3,
    );
    assert.equal(
      root().querySelectorAll(".index-chart .index-price-path").length,
      1,
    );
    const indexChart = root().querySelector(".index-chart");
    const pnlChart = root().querySelector(".pnl-chart");
    assert.ok(
      indexChart.compareDocumentPosition(pnlChart) &
        window.Node.DOCUMENT_POSITION_FOLLOWING,
      "index is above P&L",
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
    const lowerRvLegend = root().querySelector(
      ".performance-legend",
    ).textContent;
    await set("Realized / forward volatility", 200);
    await submit();
    assert.notEqual(
      root().querySelector(".performance-legend").textContent,
      lowerRvLegend,
    );
    const noDriftPrice = root().querySelector(".index-price").textContent;
    await set("Annual drift", 20);
    await submit();
    assert.match(
      root().querySelector(".index-heading").textContent,
      /annual drift 20.00%/,
    );
    assert.notEqual(
      root().querySelector(".index-price").textContent,
      noDriftPrice,
    );
    await set("Annual drift", -20);
    await submit();
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
      "settings edits don't silently alter the previous result",
    );
    await submit();
    assert.equal(root().querySelector(".sim-pending"), null);
    const svg = root().querySelector(".sim-performance svg");
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

    const openingValues = [
      ...root().querySelectorAll(".performance-value strong"),
    ].map((node) => Number(node.textContent.replace(/[^\d.-]/g, "")));
    assert.ok(
      Math.abs(openingValues[0] + openingValues[1] - openingValues[2]) < 0.02,
      "net components sum to total including entry costs",
    );
    svg.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await nextTick();
    assert.match(
      root().querySelector(".performance-time").textContent,
      /Day 0.003/,
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
    t.mock.method(URL, "createObjectURL", (blob) => {
      blobs.push(blob);
      return "blob:test";
    });
    button("Export CSV").click();
    await nextTick();
    assert.equal(blobs.length, 1);
    const csvRows = (await blobs[0].text())
      .trim()
      .split("\n")
      .slice(1)
      .map((row) => row.split(",").map(Number));
    for (const values of csvRows)
      assert.ok(
        Math.abs(values[2] + values[3] - values[4]) < 1e-6,
        "exported net components reconcile at every step",
      );
    assert.match(
      await blobs[0].text(),
      /^elapsedSeconds,spot,optionPnl,hedgePnl,totalPnl,executionCosts/,
    );
    const oldSeed = input("Path seed").value;
    button("New path").click();
    await settle();
    assert.notEqual(input("Path seed").value, oldSeed);
    await set("Tolerance", 0.01);
    await submit();
    assert.match(
      root().querySelector('[role="alert"]').textContent,
      /Tolerance/,
    );
    assert.ok(
      root().querySelector(".sim-performance"),
      "invalid settings preserve the last good result",
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
    for (let i = 0; i < 400 && button("Run simulation").disabled; i++)
      await settle();
    assert.equal(button("Run simulation").disabled, false);
    await submit();
    assert.ok(root().querySelector(".sim-performance"));
    const resultText = root().querySelector(".pnl-heading").textContent;
    root().querySelector("#tab-curve").click();
    await nextTick();
    assert.equal(root().querySelector("#panel-simulate").style.display, "none");
    button("Simulate").click();
    await nextTick();
    assert.equal(root().querySelector(".pnl-heading").textContent, resultText);
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
    assert.equal(button("Run simulation").disabled, true);
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
