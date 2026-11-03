import assert from "node:assert/strict";
import test from "node:test";
import { copyChartToClipboard, exportChartToPng } from "./export-png.js";

function setGlobal(t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => original
    ? Object.defineProperty(globalThis, name, original)
    : delete globalThis[name]);
}

function imageEnvironment(t, { imageFails = false, pngFails = false } = {}) {
  const png = new Blob(["PNG fixture"], { type: "image/png" });
  const downloads = [], canvases = [], draws = [];
  const ctx = {
    scale() {}, fillRect() {},
    drawImage: (...args) => draws.push(args),
  };
  setGlobal(t, "document", {
    createElement(tag) {
      if (tag === "a") {
        const link = { click() { downloads.push({ filename: this.download, href: this.href }); } };
        return link;
      }
      assert.equal(tag, "canvas");
      const canvas = {
        getContext: () => ctx,
        toBlob(callback, type) {
          assert.equal(type, "image/png");
          queueMicrotask(() => callback(pngFails ? null : png));
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  });
  setGlobal(t, "Image", class {
    set src(value) { queueMicrotask(() => imageFails ? this.onerror() : this.onload()); }
  });
  setGlobal(t, "XMLSerializer", class {
    serializeToString() { return "<svg xmlns='http://www.w3.org/2000/svg'/>"; }
  });
  const attributes = new Map([["viewBox", "0 0 100 50"]]);
  const clone = {
    getAttribute: (name) => attributes.get(name),
    setAttribute: (name, value) => attributes.set(name, value),
  };
  const element = { tagName: "svg", cloneNode: () => clone };
  const writes = [];
  setGlobal(t, "ClipboardItem", class {
    constructor(data) { this.data = data; }
  });
  setGlobal(t, "navigator", { clipboard: {
    write(items) {
      writes.push(items);
      return Promise.all(items.map((item) => item.data["image/png"])).then(() => {});
    },
  } });
  return { png, downloads, canvases, draws, element, writes };
}

test("copy starts the clipboard write immediately with a promised PNG and no download", async (t) => {
  const env = imageEnvironment(t);
  const copy = copyChartToClipboard({ element: env.element });
  assert.equal(env.writes.length, 1, "write must retain the button's user gesture");
  const payload = env.writes[0][0].data["image/png"];
  assert.ok(payload instanceof Promise);
  await copy;
  assert.equal(await payload, env.png);
  assert.equal(env.downloads.length, 0);
});

test("PNG rendering retains export header dimensions, scale, padding, and overlays", async (t) => {
  const env = imageEnvironment(t);
  const calls = [];
  const png = await new Promise((resolve, reject) => exportChartToPng({
    element: env.element, scale: 2, padding: 10,
    prepareSvgClone: (clone) => clone.setAttribute("viewBox", "0 -20 100 70"),
    drawBefore: () => calls.push("before"),
    drawAfter: () => calls.push("after"),
    onBlob: resolve, onError: reject,
  }));
  assert.equal(png, env.png);
  assert.equal(env.canvases[0].width, 240);
  assert.equal(env.canvases[0].height, 180);
  assert.deepEqual(calls, ["before", "after"]);
  assert.equal(env.draws.length, 1);
  assert.equal(env.downloads.length, 0);
});

test("existing export callers still download their PNG with the supplied filename", async (t) => {
  const env = imageEnvironment(t);
  exportChartToPng({ element: env.element, filename: "payoff.png" });
  await new Promise(setImmediate);
  assert.equal(env.downloads.length, 1);
  assert.equal(env.downloads[0].filename, "payoff.png");
  assert.equal(env.writes.length, 0);
});

test("canvas charts can deliver a PNG without triggering a download", async (t) => {
  const env = imageEnvironment(t);
  const element = { tagName: "canvas", width: 200, height: 100 };
  await copyChartToClipboard({ element });
  assert.equal(await env.writes[0][0].data["image/png"], env.png);
  assert.equal(env.draws[0][0], element);
  assert.equal(env.downloads.length, 0);
});

test("unsupported clipboard access reports a usable fallback", async (t) => {
  setGlobal(t, "navigator", {});
  await assert.rejects(copyChartToClipboard({}), /Use Save PNG/);
});

test("clipboard permission rejection reaches the UI", async (t) => {
  const env = imageEnvironment(t);
  const denied = new DOMException("Permission denied", "NotAllowedError");
  let payload;
  navigator.clipboard.write = (items) => {
    payload = items[0].data["image/png"];
    return Promise.reject(denied);
  };
  await assert.rejects(copyChartToClipboard({ element: env.element }), { name: "NotAllowedError" });
  await payload;
});

for (const [failure, message] of [["imageFails", /render/], ["pngFails", /encode/]]) {
  test(`copy rejects when ${failure} instead of remaining busy`, async (t) => {
    const env = imageEnvironment(t, { [failure]: true });
    await assert.rejects(copyChartToClipboard({ element: env.element }), message);
  });
}
