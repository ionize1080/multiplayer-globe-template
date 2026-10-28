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

const MARKET_DEFS = [
  { symbol: "S&P 500", yahoo: "^GSPC", name: "S&P 500" },
  { symbol: "NASDAQ", yahoo: "^IXIC", name: "NASDAQ" },
  { symbol: "HSI", yahoo: "^HSI", name: "Hang Seng" },
  { symbol: "SSE", yahoo: "000001.SS", name: "Shanghai Comp." },
] as const;

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
  return {
    latitude: data.latitude,
    longitude: data.longitude,
    altitude: data.altitude,
    velocity: data.velocity,
    visibility: data.visibility,
  };
}

async function fetchMarket(def: (typeof MARKET_DEFS)[number]): Promise<MarketQuote> {
  // range=1mo feeds the sparkline only. Yahoo's meta.chartPreviousClose on a
  // multi-week range is the *first* bar of that range (not prior session), so
  // day change MUST come from the daily series / regularMarketChangePercent.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    def.yahoo,
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
    throw new Error(`No chart for ${def.yahoo}`);
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

  // Keep last ~24 points for a clean sparkline
  const sparkline = closes.slice(-24);

  return {
    symbol: def.symbol,
    yahoo: def.yahoo,
    name: def.name,
    price,
    previousClose,
    change,
    changePct,
    currency: result.meta.currency || "USD",
    sparkline,
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
      fetchMarket(def).then(
        (v) => ({ ok: true as const, v }),
        (e) => ({ ok: false as const, e, def }),
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
        conn.send(
          JSON.stringify({
            type: "add-marker",
            position: connection.state!.position,
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

    return (
      (await routePartykitRequest(request, { ...env })) ||
      new Response("Not Found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
