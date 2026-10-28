import "./styles.css";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import usePartySocket from "partysocket/react";
import type { LegacyRef } from "react";

import type { OutgoingMessage } from "../shared";
import {
  createGlobeThree,
  type CloudMode,
  type IssSnapshot,
  type LatLngMarker,
} from "./globe-three";

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

type ClockZone = {
  id: string;
  label: string;
  city: string;
  timeZone: string;
};

type TlePayload = {
  name: string;
  line1: string;
  line2: string;
  fetchedAt: string;
};

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

const CLOCKS: ClockZone[] = [
  { id: "sg", label: "SGT", city: "Singapore", timeZone: "Asia/Singapore" },
  { id: "sh", label: "CST", city: "Shanghai", timeZone: "Asia/Shanghai" },
  { id: "utc", label: "UTC", city: "Coordinated", timeZone: "UTC" },
];

function formatPrice(n: number | null, currency: string): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const digits = n >= 1000 ? 0 : n >= 100 ? 1 : 2;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency === "CNY" ? "CNY" : currency === "HKD" ? "HKD" : "USD",
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    }).format(n);
  } catch {
    return n.toFixed(digits);
  }
}

function formatSigned(n: number | null, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}`;
}


/** Normalize ISS speed to km/s. Live TLE prop is already km/s (~7.66).
 *  WhereTheISS.at reports ~27575 as km/h → divide by 3600. */
function formatIssVelocityKms(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v > 100) return v / 3600; // km/h → km/s
  return v; // already km/s
}

function useNow(tickMs = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), tickMs);
    return () => window.clearInterval(id);
  }, [tickMs]);
  return now;
}

function useDashboard(pollMs = 45_000) {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function load(isRefresh: boolean) {
      if (!isRefresh) setStatus((s) => (s === "ready" ? s : "loading"));
      try {
        const res = await fetch("/api/dashboard");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as DashboardPayload;
        if (cancelled) return;
        setData(json);
        setStatus("ready");
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus((s) => (s === "ready" ? "ready" : "error"));
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(() => load(true), pollMs);
        }
      }
    }

    load(false);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [pollMs]);

  return { data, status, error };
}

function useIssTle(pollMs = 60 * 60 * 1000) {
  const [tle, setTle] = useState<[string, string] | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let failStreak = 0;

    async function load() {
      let ok = false;
      try {
        const res = await fetch("/api/iss-tle");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as TlePayload;
        if (cancelled) return;
        if (json.line1 && json.line2) {
          setTle([json.line1, json.line2]);
          ok = true;
          failStreak = 0;
        }
      } catch {
        /* keep last good TLE — never clear on failure */
        failStreak += 1;
      } finally {
        if (!cancelled) {
          // Fast retry when TLE missing/failing; hourly when healthy
          const delay = ok ? pollMs : Math.min(15_000 * Math.max(1, failStreak), 60_000);
          timer = window.setTimeout(load, delay);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [pollMs]);
  return tle;
}

function Sparkline({
  values,
  positive,
}: {
  values: number[];
  positive: boolean | null;
}) {
  const path = useMemo(() => {
    if (!values.length) return "";
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const w = 120;
    const h = 36;
    return values
      .map((v, i) => {
        const x = (i / Math.max(values.length - 1, 1)) * w;
        const y = h - ((v - min) / span) * (h - 4) - 2;
        return `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(" ");
  }, [values]);

  const stroke =
    positive == null ? "#94a3b8" : positive ? "#34d399" : "#f87171";
  const fill =
    positive == null
      ? "rgba(148,163,184,0.12)"
      : positive
        ? "rgba(52,211,153,0.16)"
        : "rgba(248,113,113,0.16)";

  return (
    <svg className="sparkline" viewBox="0 0 120 36" preserveAspectRatio="none" aria-hidden>
      <path d={`${path} L120 36 L0 36 Z`} fill={fill} stroke="none" />
      <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function AltitudeGauge({ altitudeKm }: { altitudeKm: number | null }) {
  const min = 350;
  const max = 450;
  const value = altitudeKm ?? 400;
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const angle = -120 + t * 240;
  const rad = (angle * Math.PI) / 180;
  const cx = 50;
  const cy = 52;
  const r = 36;
  const x = cx + r * Math.cos(rad);
  const y = cy + r * Math.sin(rad);

  const start = polar(cx, cy, r, -120);
  const end = polar(cx, cy, r, 120);

  return (
    <svg className="gauge" viewBox="0 0 100 70" aria-hidden>
      <path
        d={`M ${start.x} ${start.y} A ${r} ${r} 0 1 1 ${end.x} ${end.y}`}
        className="gauge-track"
      />
      <path
        d={`M ${start.x} ${start.y} A ${r} ${r} 0 ${t > 0.5 ? 1 : 0} 1 ${x} ${y}`}
        className="gauge-value"
      />
      <circle cx={x} cy={y} r="3.5" className="gauge-knob" />
      <text x="50" y="50" textAnchor="middle" className="gauge-text">
        {altitudeKm != null ? altitudeKm.toFixed(0) : "—"}
      </text>
      <text x="50" y="62" textAnchor="middle" className="gauge-sub">
        km alt
      </text>
    </svg>
  );
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function SkeletonCard() {
  return (
    <div className="card skeleton-card">
      <div className="skel skel-title" />
      <div className="skel skel-line" />
      <div className="skel skel-line short" />
    </div>
  );
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>();
  const [zoom, setZoom] = useState(1);
  const [counter, setCounter] = useState(0);
  const [rotationSpeed, setRotationSpeed] = useState(0.004);
  const rotationSpeedRef = useRef(rotationSpeed);
  useEffect(() => {
    rotationSpeedRef.current = rotationSpeed;
  }, [rotationSpeed]);

  const [cloudAmount, setCloudAmount] = useState(0.55);
  const cloudAmountRef = useRef(cloudAmount);
  useEffect(() => {
    cloudAmountRef.current = cloudAmount;
  }, [cloudAmount]);

  const [cloudMode, setCloudMode] = useState<CloudMode>("animated");
  const [cloudStatus, setCloudStatus] = useState("");
  const [cloudDate, setCloudDate] = useState<string | null>(null);
  const globeApiRef = useRef<ReturnType<typeof createGlobeThree> | null>(null);

  const now = useNow(1000);
  const { data, status, error } = useDashboard(45_000);
  const tle = useIssTle();
  const tleRef = useRef<[string, string] | null>(null);
  useEffect(() => {
    tleRef.current = tle;
  }, [tle]);

  const [liveIss, setLiveIss] = useState<IssSnapshot | null>(null);

  const positions = useRef<Map<string, LatLngMarker>>(new Map());
  const socketIdRef = useRef<string | null>(null);

  const socket = usePartySocket({
    room: "default",
    party: "globe",
    onMessage(evt) {
      const message = JSON.parse(evt.data as string) as OutgoingMessage;
      if (message.type === "add-marker") {
        const pos = message.position;
        if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return;
        positions.current.set(pos.id, {
          id: pos.id,
          lat: pos.lat,
          lng: pos.lng,
          size: pos.id === socket.id ? 0.12 : 0.08,
          self: pos.id === socket.id,
        });
        socketIdRef.current = socket.id;
        setCounter(positions.current.size);
      } else if (message.type === "remove-marker") {
        positions.current.delete(message.id);
        setCounter(positions.current.size);
      }
    },
  });

  useEffect(() => {
    const canvas = canvasRef.current as HTMLCanvasElement | undefined;
    if (!canvas) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => {
        const next = z - e.deltaY * 0.001;
        return Math.min(2.4, Math.max(0.55, next));
      });
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current as HTMLCanvasElement | undefined;
    if (!canvas) return;

    const globe = createGlobeThree({
      canvas,
      getRotationSpeed: () => rotationSpeedRef.current,
      getCloudAmount: () => cloudAmountRef.current,
      getMarkers: () => [...positions.current.values()],
      getTle: () => tleRef.current,
      onIssUpdate: (iss) => setLiveIss(iss),
    });
    globeApiRef.current = globe;

    return () => {
      globeApiRef.current = null;
      globe.destroy();
    };
  }, []);

  // Near-realtime clouds: fetch NASA mosaic via Worker proxy; refresh ~2h
  useEffect(() => {
    const globe = globeApiRef.current;
    if (!globe) return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function applyLive() {
      setCloudStatus("加载近实时云图…");
      try {
        const res = await fetch("/api/clouds");
        const meta = (await res.json()) as CloudMetaPayload | { ok: false; error?: string };
        if (!res.ok || !("ok" in meta) || meta.ok !== true) {
          throw new Error(
            "error" in meta && meta.error ? String(meta.error) : `clouds → ${res.status}`,
          );
        }
        if (cancelled) return;
        const result = await globe!.setCloudSource({
          mode: "live",
          url: `${meta.texturePath}?d=${encodeURIComponent(meta.date)}`,
          date: meta.date,
        });
        if (cancelled) return;
        if (!result.ok) throw new Error(result.error || "setCloudSource failed");
        setCloudDate(meta.date);
        setCloudStatus(`近实时 · ${meta.date} UTC`);
      } catch (e) {
        if (cancelled) return;
        console.warn("live clouds failed", e);
        setCloudStatus("近实时不可用，已回退动画云图");
        setCloudDate(null);
        await globe!.setCloudSource({ mode: "animated" });
        setCloudMode("animated");
      }
    }

    if (cloudMode === "animated") {
      void globe.setCloudSource({ mode: "animated" }).then(() => {
        if (!cancelled) {
          setCloudDate(null);
          setCloudStatus("");
        }
      });
      return () => {
        cancelled = true;
      };
    }

    void applyLive();
    timer = setInterval(applyLive, 2 * 60 * 60 * 1000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [cloudMode]);

  const clocks = CLOCKS.map((z) => {
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: z.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(now);
    const date = new Intl.DateTimeFormat("en-GB", {
      timeZone: z.timeZone,
      weekday: "short",
      day: "2-digit",
      month: "short",
    }).format(now);
    return { ...z, time, date };
  });

  const panelIss = liveIss
    ? {
        latitude: liveIss.latitude,
        longitude: liveIss.longitude,
        altitude: liveIss.altitude,
        velocity: liveIss.velocity,
        visibility: data?.iss?.visibility ?? "—",
      }
    : data?.iss;

  return (
    <div className="page">
      <div className="bg-grid" aria-hidden />
      <div className="bg-glow" aria-hidden />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <h1>ionize.club</h1>
            <p className="tagline">Live globe · markets · ISS orbit</p>
          </div>
        </div>
        <div className="live-pill" title="People currently connected">
          <span className="pulse" />
          <strong>{counter}</strong>
          <span>{counter === 1 ? "visitor" : "visitors"} online</span>
        </div>
      </header>

      <main className="layout">
        <aside className="rail left-rail">
          <section className="card clocks-card">
            <div className="card-head">
              <h2>World Clocks</h2>
              <span className="chip">local</span>
            </div>
            <div className="clock-list">
              {clocks.map((c) => (
                <div className="clock-row" key={c.id}>
                  <div>
                    <div className="clock-city">{c.city}</div>
                    <div className="clock-date">{c.date}</div>
                  </div>
                  <div className="clock-time">
                    <span className="clock-digits">{c.time}</span>
                    <span className="clock-tz">{c.label}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {status === "loading" && !data ? (
            <SkeletonCard />
          ) : data?.weather ? (
            <section className="card weather-card">
              <div className="card-head">
                <h2>{data.weather.city}</h2>
                <span className="chip">Open-Meteo</span>
              </div>
              <div className="weather-main">
                <div className="weather-temp">
                  {data.weather.temperature.toFixed(1)}
                  <span>°C</span>
                </div>
                <div className="weather-desc">{data.weather.description}</div>
              </div>
              <div className="stat-grid">
                <div>
                  <span className="muted">Humidity</span>
                  <strong>{data.weather.humidity}%</strong>
                </div>
                <div>
                  <span className="muted">Wind</span>
                  <strong>{data.weather.windSpeed.toFixed(0)} km/h</strong>
                </div>
              </div>
            </section>
          ) : (
            <section className="card error-card">
              <h2>Weather</h2>
              <p>Unavailable{error ? ` · ${error}` : ""}</p>
            </section>
          )}

          {status === "loading" && !data && !liveIss ? (
            <SkeletonCard />
          ) : panelIss ? (
            <section className="card iss-card">
              <div className="card-head">
                <h2>ISS Tracker</h2>
                <span className="chip glow-chip">3D · live</span>
              </div>
              <div className="iss-body">
                <AltitudeGauge altitudeKm={panelIss.altitude} />
                <div className="iss-stats">
                  <div>
                    <span className="muted">Lat / Lon</span>
                    <strong>
                      {panelIss.latitude.toFixed(2)}°, {panelIss.longitude.toFixed(2)}°
                    </strong>
                  </div>
                  <div>
                    <span className="muted">Velocity</span>
                    <strong>
                      {formatIssVelocityKms(panelIss.velocity).toFixed(2)} km/s
                    </strong>
                  </div>
                  <div>
                    <span className="muted">Visibility</span>
                    <strong className="cap">{panelIss.visibility}</strong>
                  </div>
                </div>
              </div>
              <p className="hint">Cyan orbit · amber visitors · metallic ISS on the globe</p>
            </section>
          ) : (
            <section className="card error-card">
              <h2>ISS Tracker</h2>
              <p>Orbit feed offline</p>
            </section>
          )}
        </aside>

        <section className="stage">
          <div className="globe-wrap">
            {/* Zoom scales three.js Earth + Fresnel atmosphere together */}
            <div
              className="globe-scene"
              style={{ transform: `scale(${zoom})` }}
            >
              <canvas
                ref={canvasRef as LegacyRef<HTMLCanvasElement>}
                className="globe-canvas"
              />
            </div>
          </div>
          <div className="globe-legend" aria-hidden>
            <span className="legend-dot iss" /> ISS orbit
            <span className="legend-dot visitor" /> visitors
          </div>

          <div className="speed-control card inline-card controls-row">
            <div className="control-block">
              <label htmlFor="speedRange">
                Rotation <b>{rotationSpeed.toFixed(3)}</b>
              </label>
              <input
                id="speedRange"
                type="range"
                min="0"
                max="0.03"
                step="0.001"
                value={rotationSpeed}
                onChange={(e) => setRotationSpeed(parseFloat(e.target.value))}
              />
            </div>
            <div className="control-block">
              <label htmlFor="cloudRange">
                Clouds <b>{Math.round(cloudAmount * 100)}%</b>
              </label>
              <input
                id="cloudRange"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={cloudAmount}
                onChange={(e) => setCloudAmount(parseFloat(e.target.value))}
              />
            </div>
            <div className="control-block cloud-mode-block">
              <span className="cloud-mode-label">云图模式</span>
              <div className="segmented" role="group" aria-label="云图模式">
                <button
                  type="button"
                  className={cloudMode === "animated" ? "seg active" : "seg"}
                  onClick={() => setCloudMode("animated")}
                >
                  动画云图
                </button>
                <button
                  type="button"
                  className={cloudMode === "live" ? "seg active" : "seg"}
                  onClick={() => setCloudMode("live")}
                >
                  近实时云图
                </button>
              </div>
              {cloudStatus ? (
                <p className="cloud-status" title={cloudDate || undefined}>
                  {cloudStatus}
                </p>
              ) : null}
            </div>
          </div>
        </section>

        <aside className="rail right-rail">
          <section className="card markets-card">
            <div className="card-head">
              <h2>Markets</h2>
              <span className="chip">Yahoo · 1D</span>
            </div>
            {status === "loading" && !data ? (
              <div className="market-list">
                <SkeletonCard />
                <SkeletonCard />
              </div>
            ) : data?.markets?.length ? (
              <div className="market-list">
                {data.markets.map((m) => {
                  const up = m.change == null ? null : m.change >= 0;
                  return (
                    <article
                      key={m.yahoo}
                      className={`market-item ${
                        up == null ? "" : up ? "up" : "down"
                      }`}
                    >
                      <div className="market-top">
                        <div>
                          <div className="market-symbol">{m.symbol}</div>
                          <div className="market-name">{m.name}</div>
                        </div>
                        <div className="market-price">
                          <strong>{formatPrice(m.price, m.currency)}</strong>
                          <span className={`delta ${up ? "up" : "down"}`}>
                            {formatSigned(m.changePct, 2)}%
                          </span>
                        </div>
                      </div>
                      <Sparkline values={m.sparkline} positive={up} />
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="empty">Market data unavailable</p>
            )}
            {data?.updatedAt && (
              <p className="hint">
                Updated{" "}
                {new Intl.DateTimeFormat("en-GB", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: false,
                  timeZone: "Asia/Singapore",
                }).format(new Date(data.updatedAt))}{" "}
                SGT
              </p>
            )}
          </section>
        </aside>
      </main>

      <footer className="footer">
        <span>
          Powered by <a href="https://threejs.org/">three.js</a>,{" "}
          <a href="https://npmjs.com/package/partyserver/">PartyServer</a>, Celestrak TLE,
          Open-Meteo, WhereTheISS.at & Yahoo Finance · Earth: NASA Blue Marble · clouds: animated webgl-earth / near-realtime NASA GIBS MODIS
        </span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
