// removeBgWorker.js — Web Worker 多執行緒高效去背
self.onmessage = function (e) {
  const {
    imageData,
    width,
    height,
    targetHex,
    tolerancePercent,
    erodeStrength,
    removalMode
  } = e.data;

  const data = imageData.data;

  const hexToRgb = (hex) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16)
        }
      : null;
  };

  const isPixelBackgroundHSV = (r, g, b, tolerancePercent) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;

    if (delta !== 0) {
      if (max === g) h = 60 * ((b - r) / delta + 2);
      else if (max === r) h = 60 * ((g - b) / delta + 4);
      else h = 60 * ((r - g) / delta);
    }
    if (h < 0) h += 360;

    const s = max === 0 ? 0 : delta / max;
    const v = max / 255;

    const factor = tolerancePercent / 100;
    const minSat = 0.25 * (1 - factor);
    const minVal = 0.35 * (1 - factor);

    const isGreenHue = h >= 60 && h <= 180;
    const isStandardGreen = isGreenHue && s > minSat && v > minVal;
    const isDominantGreen = g > r + 30 && g > b + 30 && g > 80;

    return isStandardGreen || isDominantGreen;
  };

  const isPixelBackground = (r, g, b, targetHex, tolerancePercent) => {
    if (targetHex.toLowerCase() === "#00ff00") {
      return isPixelBackgroundHSV(r, g, b, tolerancePercent);
    } else {
      const rgb = hexToRgb(targetHex) || { r: 0, g: 0, b: 0 };
      const dr = r - rgb.r;
      const dg = g - rgb.g;
      const db = b - rgb.b;
      const dist = dr * dr + dg * dg + db * db;
      const maxDist = 440;
      return dist <= (maxDist * (tolerancePercent / 100)) ** 2;
    }
  };

  const floodFill = () => {
    const stack = [
      [0, 0],
      [width - 1, 0],
      [0, height - 1],
      [width - 1, height - 1]
    ];
    const visited = new Uint8Array(width * height);

    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || x >= width || y < 0 || y >= height) continue;

      const idx = y * width + x;
      if (visited[idx]) continue;
      visited[idx] = 1;

      const offset = idx * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];

      if (isPixelBackground(r, g, b, targetHex, tolerancePercent)) {
        data[offset + 3] = 0;
        stack.push(
          [x + 1, y],
          [x - 1, y],
          [x, y + 1],
          [x, y - 1]
        );
      }
    }
  };

  const globalRemove = () => {
    for (let i = 0; i < data.length; i += 4) {
      if (isPixelBackground(data[i], data[i+1], data[i+2], targetHex, tolerancePercent)) {
        data[i + 3] = 0;
      }
    }
  };

  const erosion = () => {
    for (let k = 0; k < erodeStrength; k++) {
      const alpha = new Uint8Array(width * height);
      for (let i = 0; i < width * height; i++) {
        alpha[i] = data[i * 4 + 3];
      }

      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const idx = y * width + x;
          if (
            alpha[idx] > 0 &&
            (alpha[idx - 1] === 0 ||
              alpha[idx + 1] === 0 ||
              alpha[idx - width] === 0 ||
              alpha[idx + width] === 0)
          ) {
            data[idx * 4 + 3] = 0;
          }
        }
      }
    }
  };

  if (removalMode === "flood") floodFill();
  else globalRemove();

  erosion();

  self.postMessage(imageData);
};
