import { routePartykitRequest, Server } from "partyserver";

import type { OutgoingMessage, Position } from "../shared";
import type { Connection, ConnectionContext } from "partyserver";

type ConnectionState = {
  position: Position;
};

type MarketQuote = {
  symbol: string;
  yahoo: string;
  name: string;
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  currency: string;
  sparkline: number[];
  kind: "spot" | "futures";
  session: "rth" | "futures";
};

type IssData = {
  latitude: number;
  longitude: number;
  altitude: number;
  velocity: number;
  visibility: string;
};

type WeatherData = {
  city: string;
  temperature: number;
  humidity: number;
  windSpeed: number;
  weatherCode: number;
  description: string;
};

type DashboardPayload = {
  updatedAt: string;
  iss: IssData | null;
  markets: MarketQuote[];
  weather: WeatherData | null;
  errors: string[];
};

const CACHE_TTL_MS = 45_000;
const TLE_CACHE_TTL_MS = 60 * 60 * 1000;

type IssTlePayload = {
  name: string;
  line1: string;
  line2: string;
  fetchedAt: string;
  source: string;
};

let tleCache: { at: number; data: IssTlePayload } | null = null;
let tleInflight: Promise<IssTlePayload> | null = null;

async function fetchIssTle(): Promise<IssTlePayload> {
  const errors: string[] = [];

  // 1) WhereTheISS JSON TLE (most reliable from Workers)
  try {
    const data = await fetchJson<{
      name?: string;
      header?: string;
      line1: string;
      line2: string;
    }>("https://api.wheretheiss.at/v1/satellites/25544/tles");
    if (data.line1 && data.line2) {
      return {
        name: data.header || data.name || "ISS (ZARYA)",
        line1: data.line1.trim(),
        line2: data.line2.trim(),
        fetchedAt: new Date().toISOString(),
        source: "wheretheiss",
      };
    }
    errors.push("wheretheiss: missing lines");
  } catch (e) {
    errors.push(`wheretheiss: ${String(e)}`);
  }

  // 2) Celestrak GP
  try {
    const url = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=tle";
    const res = await fetch(url, {
      headers: {
        Accept: "text/plain",
        "User-Agent": "ionize.club-dashboard/1.0",
      },
    });
    if (!res.ok) throw new Error(`tle → ${res.status}`);
    const text = (await res.text()).trim();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 3) throw new Error("tle parse failed");
    // Celestrak may return name + 2 lines, or just 2 lines
    const hasName = !lines[0]!.startsWith("1 ");
    return {
      name: hasName ? lines[0]! : "ISS (ZARYA)",
      line1: hasName ? lines[1]! : lines[0]!,
      line2: hasName ? lines[2]! : lines[1]!,
      fetchedAt: new Date().toISOString(),
      source: "celestrak",
    };
  } catch (e) {
    errors.push(`celestrak: ${String(e)}`);
  }

  throw new Error(`tle failed: ${errors.join("; ")}`);
}

async function getIssTle(): Promise<IssTlePayload> {
  const now = Date.now();
  if (tleCache && now - tleCache.at < TLE_CACHE_TTL_MS) return tleCache.data;
  if (tleInflight) return tleInflight;
  tleInflight = fetchIssTle()
    .then((data) => {
      tleCache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      tleInflight = null;
    });
  try {
    return await tleInflight;
  } catch (e) {
    if (tleCache) return tleCache.data;
    throw e;
  }
}

type MarketDef = {
  symbol: string;
  yahoo: string;
  name: string;
  /** When set, used outside US regular trading hours instead of yahoo */
  futuresYahoo?: string;
  futuresSymbol?: string;
  futuresName?: string;
};

const MARKET_DEFS: MarketDef[] = [
  {
    symbol: "S&P 500",
    yahoo: "^GSPC",
    name: "S&P 500",
    futuresYahoo: "ES=F",
    futuresSymbol: "ES",
    futuresName: "E-mini S&P 500",
  },
  {
    symbol: "NASDAQ",
    yahoo: "^IXIC",
    name: "NASDAQ",
    futuresYahoo: "NQ=F",
    futuresSymbol: "NQ",
    futuresName: "E-mini Nasdaq-100",
  },
  { symbol: "HSI", yahoo: "^HSI", name: "Hang Seng" },
  { symbol: "SSE", yahoo: "000001.SS", name: "Shanghai Comp." },
];

/** US equity RTH: Mon–Fri 09:30–16:00 America/New_York (no holiday calendar). */
function isUsEquityRth(date = new Date()): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  ) as { weekday?: string; hour?: string; minute?: string };
  const wd = parts.weekday || "";
  if (wd === "Sat" || wd === "Sun") return false;
  const hour = parseInt(parts.hour || "0", 10);
  const minute = parseInt(parts.minute || "0", 10);
  const mins = hour * 60 + minute;
  // 09:30–16:00 ET inclusive of open, exclusive of close
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

const WEATHER_CODES: Record<number, string> = {
  0: "Clear",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Fog",
  51: "Drizzle",
  53: "Drizzle",
  55: "Drizzle",
  61: "Rain",
  63: "Rain",
  65: "Rain",
  71: "Snow",
  80: "Showers",
  81: "Showers",
  95: "Thunderstorm",
};

let dashboardCache: { at: number; data: DashboardPayload } | null = null;
let dashboardInflight: Promise<DashboardPayload> | null = null;

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "User-Agent": "ionize.club-dashboard/1.0",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${url} → ${res.status}`);
  }
  return (await res.json()) as T;
}

async function fetchIss(): Promise<IssData> {
  const data = await fetchJson<{
    latitude: number;
    longitude: number;
    altitude: number;
    velocity: number;
    visibility: string;
  }>("https://api.wheretheiss.at/v1/satellites/25544");
  // WhereTheISS velocity is km/h (~27575) → store as km/s for the panel
  return {
    latitude: data.latitude,
    longitude: data.longitude,
    altitude: data.altitude,
    velocity: data.velocity / 3600,
    visibility: data.visibility,
  };
}

async function fetchYahooChart(yahoo: string): Promise<{
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  currency: string;
  sparkline: number[];
}> {
  // range=1mo feeds the sparkline only. Yahoo's meta.chartPreviousClose on a
  // multi-week range is the *first* bar of that range (not prior session), so
  // day change MUST come from the daily series / regularMarketChangePercent.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    yahoo,
  )}?interval=1d&range=1mo`;
  const data = await fetchJson<{
    chart: {
      result?: Array<{
        meta: {
          regularMarketPrice?: number;
          chartPreviousClose?: number;
          previousClose?: number;
          regularMarketChangePercent?: number;
          currency?: string;
        };
        indicators: { quote: Array<{ close: Array<number | null> }> };
      }>;
      error?: unknown;
    };
  }>(url);

  const result = data.chart.result?.[0];
  if (!result) {
    throw new Error(`No chart for ${yahoo}`);
  }

  const closes = (result.indicators.quote[0]?.close || []).filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  const price = result.meta.regularMarketPrice ?? closes.at(-1) ?? null;
  // Prior trading session close = second-to-last daily close (NOT chartPreviousClose).
  const previousClose = closes.length > 1 ? closes[closes.length - 2] : null;
  const change =
    price != null && previousClose != null ? price - previousClose : null;
  const changePct =
    typeof result.meta.regularMarketChangePercent === "number" &&
    Number.isFinite(result.meta.regularMarketChangePercent)
      ? result.meta.regularMarketChangePercent
      : change != null && previousClose
        ? (change / previousClose) * 100
        : null;

  return {
    price,
    previousClose,
    change,
    changePct,
    currency: result.meta.currency || "USD",
    sparkline: closes.slice(-24),
  };
}

async function fetchMarket(def: MarketDef, preferFutures: boolean): Promise<MarketQuote> {
  const useFutures = Boolean(preferFutures && def.futuresYahoo);
  const yahoo = useFutures ? def.futuresYahoo! : def.yahoo;
  const chart = await fetchYahooChart(yahoo);
  return {
    symbol: useFutures ? def.futuresSymbol || def.symbol : def.symbol,
    yahoo,
    name: useFutures ? def.futuresName || def.name : def.name,
    ...chart,
    kind: useFutures ? "futures" : "spot",
    session: useFutures ? "futures" : "rth",
  };
}

async function fetchSingaporeWeather(): Promise<WeatherData> {
  const data = await fetchJson<{
    current: {
      temperature_2m: number;
      relative_humidity_2m: number;
      wind_speed_10m: number;
      weather_code: number;
    };
  }>(
    "https://api.open-meteo.com/v1/forecast?latitude=1.3521&longitude=103.8198&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=Asia%2FSingapore",
  );
  const code = data.current.weather_code;
  return {
    city: "Singapore",
    temperature: data.current.temperature_2m,
    humidity: data.current.relative_humidity_2m,
    windSpeed: data.current.wind_speed_10m,
    weatherCode: code,
    description: WEATHER_CODES[code] || "Unknown",
  };
}

async function buildDashboard(): Promise<DashboardPayload> {
  const errors: string[] = [];
  const usRth = isUsEquityRth();
  const preferFutures = !usRth;
  const [issSettled, weatherSettled, ...marketSettled] = await Promise.all([
    fetchIss().then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    ),
    fetchSingaporeWeather().then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    ),
    ...MARKET_DEFS.map((def) =>
      fetchMarket(def, preferFutures).then(
        (v) => ({ ok: true as const, v }),
        (e) =>
          // Futures fallback → spot if ES/NQ chart fails
          preferFutures && def.futuresYahoo
            ? fetchMarket(def, false).then(
                (v) => ({ ok: true as const, v }),
                (e2) => ({ ok: false as const, e: e2, def }),
              )
            : Promise.resolve({ ok: false as const, e, def }),
      ),
    ),
  ]);

  const markets: MarketQuote[] = [];
  for (const item of marketSettled) {
    if (item.ok) markets.push(item.v);
    else {
      errors.push(`market:${"def" in item ? item.def.symbol : "?"} failed`);
      console.warn("market fetch failed", item.e);
    }
  }

  if (!issSettled.ok) {
    errors.push("iss failed");
    console.warn("iss fetch failed", issSettled.e);
  }
  if (!weatherSettled.ok) {
    errors.push("weather failed");
    console.warn("weather fetch failed", weatherSettled.e);
  }

  return {
    updatedAt: new Date().toISOString(),
    iss: issSettled.ok ? issSettled.v : null,
    markets,
    weather: weatherSettled.ok ? weatherSettled.v : null,
    errors,
  };
}

async function getDashboard(): Promise<DashboardPayload> {
  const now = Date.now();
  if (dashboardCache && now - dashboardCache.at < CACHE_TTL_MS) {
    return dashboardCache.data;
  }
  if (dashboardInflight) return dashboardInflight;

  dashboardInflight = buildDashboard()
    .then((data) => {
      dashboardCache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      dashboardInflight = null;
    });

  try {
    return await dashboardInflight;
  } catch (e) {
    if (dashboardCache) return dashboardCache.data;
    throw e;
  }
}

const CLOUD_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const CLOUD_WIDTH = 2048;
const CLOUD_HEIGHT = 1024;
/** True-color mosaics → client extracts white cloud alpha (COT false-color was empty/striped). */
const CLOUD_LAYERS = [
  "MODIS_Terra_CorrectedReflectance_TrueColor",
  "VIIRS_SNPP_CorrectedReflectance_TrueColor",
] as const;
const CLOUD_MIN_BYTES = 400_000;

type CloudMetaPayload = {
  ok: true;
  date: string;
  layer: string;
  source: string;
  texturePath: string;
  width: number;
  height: number;
  refreshedAt: string;
  lagNote: string;
};

type CloudCacheEntry = {
  at: number;
  meta: CloudMetaPayload;
  bytes: ArrayBuffer;
  contentType: string;
};

let cloudCache: CloudCacheEntry | null = null;
let cloudInflight: Promise<CloudCacheEntry> | null = null;

function utcYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function cloudSnapshotUrl(layer: string, date: string): string {
  const params = new URLSearchParams({
    REQUEST: "GetSnapshot",
    LAYERS: layer,
    CRS: "EPSG:4326",
    TIME: date,
    WRAP: "DAY",
    BBOX: "-90,-180,90,180",
    FORMAT: "image/png",
    WIDTH: String(CLOUD_WIDTH),
    HEIGHT: String(CLOUD_HEIGHT),
    AUTOSCALE: "TRUE",
  });
  return `https://wvs.earthdata.nasa.gov/api/v1/snapshot?${params}`;
}

async function fetchBestCloudMosaic(): Promise<CloudCacheEntry> {
  const now = new Date();
  const errors: string[] = [];

  // Prefer yesterday first: "today" UTC true-color is often half-black (orbit not finished).
  const dayOffsets = [1, 0, 2, 3];

  for (const back of dayOffsets) {
    const day = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back),
    );
    const date = utcYmd(day);
    for (const layer of CLOUD_LAYERS) {
      try {
        const res = await fetch(cloudSnapshotUrl(layer, date), {
          headers: {
            Accept: "image/png",
            "User-Agent": "ionize.club-clouds/1.0",
          },
        });
        if (!res.ok) {
          errors.push(`${date}/${layer}: HTTP ${res.status}`);
          continue;
        }
        const present = res.headers.get("data-present");
        const bytes = await res.arrayBuffer();
        if (bytes.byteLength < CLOUD_MIN_BYTES) {
          errors.push(`${date}/${layer}: too small (${bytes.byteLength} B)`);
          continue;
        }
        if (present === "false") {
          errors.push(`${date}/${layer}: data-present=false`);
          continue;
        }
        // True-color mosaics are ~0.8–2MB; reject tiny/error HTML mistaken as PNG
        const head = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength));
        const isPng =
          head.length >= 8 &&
          head[0] === 0x89 &&
          head[1] === 0x50 &&
          head[2] === 0x4e &&
          head[3] === 0x47;
        if (!isPng) {
          errors.push(`${date}/${layer}: not PNG`);
          continue;
        }
        const meta: CloudMetaPayload = {
          ok: true,
          date,
          layer,
          source: "NASA GIBS via Worldview Snapshots",
          texturePath: "/api/clouds/texture",
          width: CLOUD_WIDTH,
          height: CLOUD_HEIGHT,
          refreshedAt: new Date().toISOString(),
          lagNote:
            "Daytime corrected reflectance (Terra/VIIRS); client extracts white cloud mask. Typically hours–1 day behind; night side incomplete.",
        };
        return {
          at: Date.now(),
          meta,
          bytes,
          contentType: res.headers.get("content-type") || "image/png",
        };
      } catch (e) {
        errors.push(`${date}/${layer}: ${String(e)}`);
      }
    }
  }

  throw new Error(`cloud mosaic unavailable: ${errors.join("; ")}`);
}

async function getCloudMosaic(): Promise<CloudCacheEntry> {
  const now = Date.now();
  if (cloudCache && now - cloudCache.at < CLOUD_CACHE_TTL_MS) return cloudCache;
  if (cloudInflight) return cloudInflight;
  cloudInflight = fetchBestCloudMosaic()
    .then((entry) => {
      cloudCache = entry;
      return entry;
    })
    .finally(() => {
      cloudInflight = null;
    });
  try {
    return await cloudInflight;
  } catch (e) {
    if (cloudCache) return cloudCache;
    throw e;
  }
}

export class Globe extends Server {
  onConnect(conn: Connection<ConnectionState>, ctx: ConnectionContext) {
    const latitude = ctx.request.cf?.latitude as string | undefined;
    const longitude = ctx.request.cf?.longitude as string | undefined;
    if (!latitude || !longitude) {
      console.warn(`Missing position information for connection ${conn.id}`);
      return;
    }
    const position = {
      lat: parseFloat(latitude),
      lng: parseFloat(longitude),
      id: conn.id,
    };
    conn.setState({ position });

    for (const connection of this.getConnections<ConnectionState>()) {
      try {
        const existing = connection.state?.position;
        // Skip ghost sockets that never got a CF lat/lng (no marker state)
        if (!existing) continue;
        conn.send(
          JSON.stringify({
            type: "add-marker",
            position: existing,
          } satisfies OutgoingMessage),
        );

        if (connection.id !== conn.id) {
          connection.send(
            JSON.stringify({
              type: "add-marker",
              position,
            } satisfies OutgoingMessage),
          );
        }
      } catch {
        this.onCloseOrError(conn);
      }
    }
  }

  onCloseOrError(connection: Connection) {
    this.broadcast(
      JSON.stringify({
        type: "remove-marker",
        id: connection.id,
      } satisfies OutgoingMessage),
      [connection.id],
    );
  }

  onClose(connection: Connection): void | Promise<void> {
    this.onCloseOrError(connection);
  }

  onError(connection: Connection): void | Promise<void> {
    this.onCloseOrError(connection);
  }
}


const STARLINK_CACHE_TTL_MS = 30 * 60 * 1000;

type StarlinkTlePair = [string, string];

type StarlinkPayload = {
  ok: true;
  count: number;
  source: string;
  fetchedAt: string;
  catalogUrl: string;
  tles: StarlinkTlePair[];
  note: string;
};

let starlinkCache: { at: number; data: StarlinkPayload } | null = null;
let starlinkInflight: Promise<StarlinkPayload> | null = null;

function parseStarlinkTleText(text: string): StarlinkTlePair[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: StarlinkTlePair[] = [];
  let i = 0;
  while (i < lines.length) {
    const a = (lines[i] || "").trim();
    if (!a) {
      i += 1;
      continue;
    }
    // Celestrak GROUP TLE: name, L1, L2
    if (a.startsWith("1 ") && i + 1 < lines.length) {
      const l1 = a;
      const l2 = (lines[i + 1] || "").trim();
      if (l2.startsWith("2 ")) {
        out.push([l1, l2]);
        i += 2;
        continue;
      }
    }
    if (!a.startsWith("1 ") && !a.startsWith("2 ") && i + 2 < lines.length) {
      const l1 = (lines[i + 1] || "").trim();
      const l2 = (lines[i + 2] || "").trim();
      if (l1.startsWith("1 ") && l2.startsWith("2 ")) {
        out.push([l1, l2]);
        i += 3;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

async function fetchStarlinkCatalog(): Promise<StarlinkPayload> {
  const urls = [
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle",
    "https://www.celestrak.com/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle",
  ];
  const headers = {
    Accept: "text/plain,*/*",
    "User-Agent": "ionize.club-globe/1.0 (educational; contact via ionize.club)",
  };
  let lastErr: unknown;
  for (const catalogUrl of urls) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(catalogUrl, { headers });
        if (!res.ok) throw new Error(`Celestrak Starlink → ${res.status}`);
        const text = await res.text();
        if (!text || text.length < 100) throw new Error("Celestrak Starlink empty body");
        const tles = parseStarlinkTleText(text);
        if (tles.length < 100) throw new Error(`Starlink parse too small: ${tles.length}`);
        return {
          ok: true,
          count: tles.length,
          source: "Celestrak GP · GROUP=starlink",
          fetchedAt: new Date().toISOString(),
          catalogUrl,
          tles,
          note: "Active Starlink TLEs from Celestrak; positions via client SGP4",
        };
      } catch (e) {
        lastErr = e;
      }
    }
  }
  // Serve last good cache if upstream flaps (522 etc.)
  if (starlinkCache?.data) {
    return {
      ...starlinkCache.data,
      note: `${starlinkCache.data.note} (stale cache; upstream: ${String(lastErr)})`,
    };
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchStarlinkSampleAsset(origin: string): Promise<StarlinkPayload> {
  const catalogUrl = new URL("/starlink-sample.tle", origin).toString();
  const res = await fetch(catalogUrl);
  if (!res.ok) throw new Error(`starlink-sample.tle → ${res.status}`);
  const text = await res.text();
  const tles = parseStarlinkTleText(text);
  if (tles.length < 50) throw new Error(`starlink-sample too small: ${tles.length}`);
  return {
    ok: true,
    count: tles.length,
    source: "Bundled sample · starlink-sample.tle (Celestrak snapshot)",
    fetchedAt: new Date().toISOString(),
    catalogUrl,
    tles,
    note: "Fallback sample when Celestrak unreachable from Worker; thinned snapshot",
  };
}

async function getStarlinkCatalog(origin?: string): Promise<StarlinkPayload> {
  const now = Date.now();
  if (starlinkCache && now - starlinkCache.at < STARLINK_CACHE_TTL_MS) {
    return starlinkCache.data;
  }
  if (starlinkInflight) return starlinkInflight;
  starlinkInflight = (async () => {
    try {
      return await fetchStarlinkCatalog();
    } catch (e) {
      if (origin) {
        try {
          return await fetchStarlinkSampleAsset(origin);
        } catch (e2) {
          throw e;
        }
      }
      throw e;
    }
  })()
    .then((data) => {
      starlinkCache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      starlinkInflight = null;
    });
  return starlinkInflight;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/location") {
      const cf = request.cf as Record<string, string | undefined>;
      return Response.json({
        city: cf?.city ?? "",
        latitude: cf?.latitude ?? "",
        longitude: cf?.longitude ?? "",
      });
    }

    if (request.method === "GET" && url.pathname === "/api/iss-tle") {
      try {
        const data = await getIssTle();
        return Response.json(data, {
          headers: {
            "Cache-Control": "public, max-age=300",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e) {
        return Response.json(
          { error: String(e) },
          { status: 502, headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      try {
        const data = await getDashboard();
        return Response.json(data, {
          headers: {
            "Cache-Control": "public, max-age=30",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e) {
        return Response.json(
          {
            updatedAt: new Date().toISOString(),
            iss: null,
            markets: [],
            weather: null,
            errors: [String(e)],
          },
          { status: 502 },
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/api/clouds") {
      try {
        const entry = await getCloudMosaic();
        return Response.json(entry.meta, {
          headers: {
            "Cache-Control": "public, max-age=600",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e) {
        return Response.json(
          { ok: false, error: String(e) },
          {
            status: 502,
            headers: { "Access-Control-Allow-Origin": "*" },
          },
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/api/clouds/texture") {
      try {
        const entry = await getCloudMosaic();
        return new Response(entry.bytes, {
          headers: {
            "Content-Type": entry.contentType,
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
            "X-Cloud-Date": entry.meta.date,
            "X-Cloud-Layer": entry.meta.layer,
          },
        });
      } catch (e) {
        return Response.json(
          { ok: false, error: String(e) },
          {
            status: 502,
            headers: { "Access-Control-Allow-Origin": "*" },
          },
        );
      }
    }


    if (request.method === "GET" && url.pathname === "/api/starlink") {
      try {
        const data = await getStarlinkCatalog(url.origin);
        const includeTles = url.searchParams.get("tles") !== "0";
        const maxRaw = Number(url.searchParams.get("max") || "2200");
        const max = Number.isFinite(maxRaw)
          ? Math.min(8000, Math.max(200, Math.floor(maxRaw)))
          : 2200;
        let tles = includeTles ? data.tles : ([] as StarlinkTlePair[]);
        let drawn = tles.length;
        if (includeTles && tles.length > max) {
          const step = Math.ceil(tles.length / max);
          const thin: StarlinkTlePair[] = [];
          for (let i = 0; i < tles.length && thin.length < max; i += step) {
            thin.push(tles[i]!);
          }
          tles = thin;
          drawn = thin.length;
        }
        const body = {
          ok: true as const,
          count: data.count,
          drawn,
          source: data.source,
          fetchedAt: data.fetchedAt,
          catalogUrl: data.catalogUrl,
          note: includeTles
            ? `${data.note}; response thinned to ${drawn} for globe Points`
            : data.note,
          tles,
        };
        return Response.json(body, {
          headers: {
            "Cache-Control": "public, max-age=600",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e) {
        return Response.json(
          { ok: false, error: String(e) },
          {
            status: 502,
            headers: { "Access-Control-Allow-Origin": "*" },
          },
        );
      }
    }

    return (
      (await routePartykitRequest(request, { ...env })) ||
      new Response("Not Found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
