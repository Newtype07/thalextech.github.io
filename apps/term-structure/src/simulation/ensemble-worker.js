import { positionEnsemble } from "./position-ensemble.js";

self.onmessage = ({ data: config }) => {
  try {
    const batch = positionEnsemble(config);
    let next = batch.next();
    while (!next.done) {
      self.postMessage({ type: "progress", ...next.value });
      next = batch.next();
    }
    self.postMessage({ type: "result", result: next.value });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message });
  }
};
