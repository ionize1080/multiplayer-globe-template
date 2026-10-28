const ORIGIN = "https://clouds.matteason.co.uk";

export function cloudWidth(value: string | null): number {
  return value === "2048" ? 2048 : 4096;
}

export function cloudTextureUrl(width: number): string {
  return `${ORIGIN}/images/${width}x${width / 2}/clouds-alpha.png`;
}

/** Do not label HTTP retrieval/publication time as the satellite observation time. */
export async function cloudMetadata(width: number) {
  const response = await fetch(cloudTextureUrl(width), {
    method: "HEAD", signal: AbortSignal.timeout(20_000),
    cf: { cacheTtl: 600, cacheEverything: true },
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("image/png")) {
    throw new Error("Cloud provider unavailable");
  }
  const revision = response.headers.get("etag");
  if (!revision) throw new Error("Cloud provider returned no image revision");
  return {
    ok: true as const,
    source: "EUMETSAT / Live Cloud Maps",
    sourceUrl: "https://github.com/matteason/live-cloud-maps",
    observedAt: null,
    publishedAt: response.headers.get("last-modified"),
    checkedAt: new Date().toISOString(),
    revision,
    width, height: width / 2,
    texturePath: `/api/clouds/texture?width=${width}&revision=${encodeURIComponent(revision)}`,
    cadenceHours: 3,
    attribution: "Contains modified EUMETSAT data",
    lagNote: "约每 3 小时发布；上游未提供观测时刻。极区不覆盖，偶有缺测。",
  };
}

export async function cloudTexture(width: number, revision: string | null): Promise<Response> {
  const response = await fetch(cloudTextureUrl(width), {
    signal: AbortSignal.timeout(30_000),
    cf: { cacheTtl: 600, cacheEverything: true },
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("image/png") || !response.body) {
    await response.body?.cancel();
    throw new Error("Cloud texture unavailable");
  }
  // The upstream URL means 'latest'. Refuse a different image instead of applying
  // a revision label to pixels downloaded during a provider update.
  const actualRevision = response.headers.get("etag");
  if (revision && revision !== actualRevision) {
    await response.body.cancel();
    return Response.json({ ok: false, error: "Cloud image changed; refresh metadata" }, { status: 409 });
  }
  // Stream multi-megabyte PNGs; never keep full 4K images in Worker isolate memory.
  return new Response(response.body, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=600",
      "Access-Control-Allow-Origin": "*",
      "X-Cloud-Revision": actualRevision || "unknown",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
