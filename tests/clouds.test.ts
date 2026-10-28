import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCloudRows } from "../src/client/cloud-mask";
import { cloudMetadata, cloudTexture, cloudWidth, cloudTextureUrl } from "../src/server/clouds";

test("cloud masks preserve transparent holes, wisps and storm cores without gray RGB or polar fabrication", () => {
  const width = 4, height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set([100, 100, 100, [0, 50, 150, 255][x]], (y * width + x) * 4);
  }
  normalizeCloudRows(data, width, height, 0, height);
  const row = (height / 2) * width * 4;
  assert.equal(data[row + 3], 0, "missing coverage stays transparent");
  assert.ok(data[row + 7] > 0 && data[row + 7] < 50, "thin wisps survive with reduced haze");
  assert.equal(data[row + 15], 255, "storm core remains intact");
  assert.equal(data[15], 0, "mirrored polar filler is suppressed");
  for (let i = 0; i < data.length; i += 4) assert.deepEqual(Array.from(data.slice(i, i + 3)), [255, 255, 255]);
});

test("quality inputs are allowlisted and cannot become arbitrary upstream requests", () => {
  assert.equal(cloudWidth("2048"), 2048);
  for (const value of [null, "8192", "0", "https://example.com"]) assert.equal(cloudWidth(value), 4096);
  assert.equal(cloudTextureUrl(4096), "https://clouds.matteason.co.uk/images/4096x2048/clouds-alpha.png");
});

test("metadata never passes publication/check time off as observation time; changed revisions fail closed", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("png", {
      headers: { "Content-Type": "image/png", ETag: '"revision-b"', "Last-Modified": "Wed, 28 Oct 2026 12:00:00 GMT" },
    });
    const meta = await cloudMetadata(2048);
    assert.equal(meta.observedAt, null);
    assert.equal(meta.revision, '"revision-b"');
    assert.ok(meta.texturePath.includes("revision="));
    assert.equal((await cloudTexture(2048, '"revision-a"')).status, 409);
    const image = await cloudTexture(2048, '"revision-b"');
    assert.equal(image.status, 200);
    assert.equal(await image.text(), "png");
    globalThis.fetch = async () => new Response("upstream error", { status: 503 });
    await assert.rejects(cloudMetadata(2048));
    await assert.rejects(cloudTexture(2048, null));
  } finally { globalThis.fetch = original; }
});
