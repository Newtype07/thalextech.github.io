/** Own the browser worker lifecycle; simulation data has no browser dependencies. */
export function runPositionEnsemble(config, { signal, onProgress }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Cancelled", "AbortError"));
    const worker = new Worker(new URL("./ensemble-worker.js", import.meta.url), { type: "module" });
    const finish = (callback, value) => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      signal.removeEventListener("abort", cancel);
      callback(value);
    };
    const cancel = () => finish(reject, new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") onProgress(data.completed);
      else if (data.type === "result") finish(resolve, data.result);
      else if (data.type === "error") finish(reject, new Error(data.message));
    };
    worker.onerror = (event) => finish(reject, new Error(event.message || "Simulation worker failed."));
    try {
      worker.postMessage(config);
    } catch (error) {
      finish(reject, error);
    }
  });
}
