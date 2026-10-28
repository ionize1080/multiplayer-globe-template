/** Preserve measured cloud alpha; strip gray RGB tint and the provider's mirrored polar fill. */
export function normalizeCloudRows(pixels: Uint8ClampedArray, width: number, height: number, y0: number, y1: number) {
  for (let y = y0; y < y1; y++) {
    const latitude = Math.abs(90 - (y + 0.5) / height * 180);
    const polar = 1 - smoothstep(60, 67.5, latitude);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const density = pixels[i + 3] / 255;
      // A gentle toe removes the uniform low-alpha haze without flattening storm cores.
      pixels[i + 3] = Math.round(255 * density * smoothstep(0.04, 0.4, density) * polar);
      pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
    }
  }
}

function smoothstep(low: number, high: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}
