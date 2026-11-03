export function exportChartToPng({
  element,
  filename = "chart.png",
  scale = 4,
  padding = 16,
  background = "#000",
  imageFilter = "none",
  prepareSvgClone,
  drawBefore,
  drawAfter,
  onBlob,
  onError,
} = {}) {
  if (!element) {
    onError?.(new Error("No chart is available to export."));
    return;
  }
  const baseOptions = { filename, scale, padding, background, imageFilter, onBlob, onError };

  const tagName = element?.tagName?.toLowerCase();
  const isCanvas = tagName === "canvas";
  const isSvg = tagName === "svg";

  if (!isCanvas && !isSvg) {
    throw new Error("Export failed: Element must be <svg> or <canvas>.");
  }

  if (isCanvas) {
    exportCanvasToPng({
      canvasEl: element,
      ...baseOptions,
      drawBeforeCanvas: drawBefore,
      drawAfterCanvas: drawAfter,
    });
    return;
  }

  exportSvgToPng({
    svgEl: element,
    ...baseOptions,
    prepareSvgClone,
    drawBeforeSvg: drawBefore,
    drawAfterSvg: drawAfter,
  });
}

export function copyChartToClipboard(options) {
  if (!globalThis.navigator?.clipboard?.write || !globalThis.ClipboardItem) {
    return Promise.reject(new Error("Copy image is unavailable in this browser. Use Save PNG instead."));
  }
  const png = new Promise((resolve, reject) => {
    exportChartToPng({ ...options, onBlob: resolve, onError: reject });
  });
  // Start the write during the click gesture; Safari needs a promised payload
  // rather than a write after the asynchronous image rendering has finished.
  png.catch(() => {}); // Rendering may fail even if clipboard access was denied first.
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

function downloadPng(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function isValidDimension(value) {
  return Number.isFinite(value) && value > 0;
}

function drawImageWithFilter(ctx, image, imageFilter, ...args) {
  if (!imageFilter || imageFilter === "none") {
    ctx.drawImage(image, ...args);
    return;
  }

  ctx.save();
  ctx.filter = imageFilter;
  ctx.drawImage(image, ...args);
  ctx.restore();
}

export function exportSvgToPng({
  svgEl,
  filename = "chart.png",
  scale = 4,
  padding = 16,
  background = "#000",
  imageFilter = "none",
  prepareSvgClone,
  drawBeforeSvg,
  drawAfterSvg,
  onBlob = (blob) => downloadPng(blob, filename),
  onError,
} = {}) {
  if (!svgEl) {
    onError?.(new Error("No chart is available to export."));
    return;
  }

  const svgClone = svgEl.cloneNode(true);
  if (typeof prepareSvgClone === "function") {
    prepareSvgClone(svgClone);
  }

  let width;
  let height;

  const viewBox = svgClone.getAttribute("viewBox") || svgEl.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox.split(" ").map(Number);
    if (parts.length === 4) {
      const vbWidth = parts[2];
      const vbHeight = parts[3];
      if (isValidDimension(vbWidth)) width = vbWidth;
      if (isValidDimension(vbHeight)) height = vbHeight;
    }
  }
  if (!svgClone.getAttribute("xmlns")) {
    svgClone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }
  svgClone.setAttribute("width", String(width));
  svgClone.setAttribute("height", String(height));

  const serializer = new XMLSerializer();
  const source = serializer.serializeToString(svgClone);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const image = new Image();
  image.onload = () => {
    try {
      const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
      const safePadding = Number.isFinite(padding) && padding >= 0 ? padding : 0;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round((width + safePadding * 2) * safeScale);
      canvas.height = Math.round((height + safePadding * 2) * safeScale);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        onError?.(new Error("Could not create the chart image."));
        return;
      }

      ctx.scale(safeScale, safeScale);
      if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width + safePadding * 2, height + safePadding * 2);
      }

      if (typeof drawBeforeSvg === "function") {
        drawBeforeSvg({
          ctx,
          width,
          height,
          padding: safePadding,
          scale: safeScale,
        });
      }

      drawImageWithFilter(
        ctx,
        image,
        imageFilter,
        safePadding,
        safePadding,
        width,
        height,
      );

      if (typeof drawAfterSvg === "function") {
        drawAfterSvg({
          ctx,
          width,
          height,
          padding: safePadding,
          scale: safeScale,
        });
      }

      canvas.toBlob((pngBlob) => {
        if (!pngBlob) {
          URL.revokeObjectURL(url);
          onError?.(new Error("Could not encode the chart as PNG."));
          return;
        }
        URL.revokeObjectURL(url);
        onBlob(pngBlob);
      }, "image/png");
    } catch (error) {
      URL.revokeObjectURL(url);
      onError?.(error);
    }
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    onError?.(new Error("Could not render the chart image."));
  };
  image.src = url;
}

function exportCanvasToPng({
  canvasEl,
  filename,
  scale,
  padding,
  background,
  imageFilter,
  drawBeforeCanvas,
  drawAfterCanvas,
  onBlob = (blob) => downloadPng(blob, filename || "chart.png"),
  onError,
} = {}) {
  if (!canvasEl) return;

  let width = Number.isFinite(canvasEl.width) ? canvasEl.width : 0;
  let height = Number.isFinite(canvasEl.height) ? canvasEl.height : 0;

  if (
    !isValidDimension(width) &&
    typeof canvasEl.getBoundingClientRect === "function"
  ) {
    const rect = canvasEl.getBoundingClientRect();
    if (isValidDimension(rect.width)) width = rect.width;
    if (isValidDimension(rect.height)) height = rect.height;
  }

  if (!isValidDimension(width) || !isValidDimension(height)) {
    onError?.(new Error("The chart has no image dimensions."));
    return;
  }

  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const safePadding = Number.isFinite(padding) && padding >= 0 ? padding : 0;
  const output = document.createElement("canvas");
  output.width = Math.round((width + safePadding * 2) * safeScale);
  output.height = Math.round((height + safePadding * 2) * safeScale);
  const ctx = output.getContext("2d");
  if (!ctx) {
    onError?.(new Error("Could not create the chart image."));
    return;
  }

  ctx.scale(safeScale, safeScale);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width + safePadding * 2, height + safePadding * 2);
  }

  if (drawBeforeCanvas) {
    drawBeforeCanvas({
      ctx,
      width,
      height,
      padding: safePadding,
      scale: safeScale,
    });
  }

  drawImageWithFilter(
    ctx,
    canvasEl,
    imageFilter,
    safePadding,
    safePadding,
    width,
    height,
  );

  if (drawAfterCanvas) {
    drawAfterCanvas({
      ctx,
      width,
      height,
      padding: safePadding,
      scale: safeScale,
    });
  }

  output.toBlob((pngBlob) => {
    if (!pngBlob) {
      onError?.(new Error("Could not encode the chart as PNG."));
      return;
    }
    onBlob(pngBlob);
  }, "image/png");
}
