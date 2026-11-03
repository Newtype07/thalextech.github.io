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
} = {}) {
  if (!element) return;
  const baseOptions = { filename, scale, padding, background, imageFilter };

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
} = {}) {
  if (!svgEl) return;

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
    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const safePadding = Number.isFinite(padding) && padding >= 0 ? padding : 0;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round((width + safePadding * 2) * safeScale);
    canvas.height = Math.round((height + safePadding * 2) * safeScale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      URL.revokeObjectURL(url);
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
        return;
      }
      const downloadUrl = URL.createObjectURL(pngBlob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(downloadUrl);
      URL.revokeObjectURL(url);
    }, "image/png");
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
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
    return;
  }

  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const safePadding = Number.isFinite(padding) && padding >= 0 ? padding : 0;
  const output = document.createElement("canvas");
  output.width = Math.round((width + safePadding * 2) * safeScale);
  output.height = Math.round((height + safePadding * 2) * safeScale);
  const ctx = output.getContext("2d");
  if (!ctx) return;

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
    if (!pngBlob) return;
    const downloadUrl = URL.createObjectURL(pngBlob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = filename || "chart.png";
    link.click();
    URL.revokeObjectURL(downloadUrl);
  }, "image/png");
}
