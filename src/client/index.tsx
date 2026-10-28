import "./styles.css";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import usePartySocket from "partysocket/react";
import type { LegacyRef } from "react";

import type { OutgoingMessage } from "../shared";
import type { SunLighting } from "./sun-lighting";
import {
  createGlobeThree,
  LIVE_CLOUDS_BUILD,
  GLOBE_FX_BUILD,
  type CloudMode,
  type IssSnapshot,
  type LatLngMarker,
  type StarlinkTlePair,
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
  /** spot = RTH cash index; futures = after-hours ES/NQ etc. */
  kind?: "spot" | "futures";
  session?: "rth" | "futures";
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
  source: string;
  observedAt: string | null;
  checkedAt: string;
  revision: string;
  texturePath: string;
  width: number;
  height: number;
  lagNote: string;
};

type StarlinkStats = {
  ok: true;
  count: number;
  source: string;
  fetchedAt: string;
  note?: string;
};

type InteractionMode = "rotate" | "drag";

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

  const [cloudAmount, setCloudAmount] = useState(0.48);
  const cloudAmountRef = useRef(cloudAmount);
  useEffect(() => {
    cloudAmountRef.current = cloudAmount;
  }, [cloudAmount]);

  const [cloudMode, setCloudMode] = useState<CloudMode>("live");
  const [cloudStatus, setCloudStatus] = useState("");
  const [cloudMeta, setCloudMeta] = useState<CloudMetaPayload | null>(null);
  const [cloudWidth, setCloudWidth] = useState(4096);
  const cloudLoadedRef = useRef(false);
  const globeApiRef = useRef<ReturnType<typeof createGlobeThree> | null>(null);

  const now = useNow(1000);
  const { data, status, error } = useDashboard(45_000);
  const tle = useIssTle();
  const tleRef = useRef<[string, string] | null>(null);
  useEffect(() => {
    tleRef.current = tle;
  }, [tle]);

  const [liveIss, setLiveIss] = useState<IssSnapshot | null>(null);

  const [showIss, setShowIss] = useState(true);
  const showIssRef = useRef(showIss);
  useEffect(() => {
    showIssRef.current = showIss;
  }, [showIss]);

  const [showStarlink, setShowStarlink] = useState(false);
  const showStarlinkRef = useRef(showStarlink);
  useEffect(() => {
    showStarlinkRef.current = showStarlink;
  }, [showStarlink]);

  const [interactionMode, setInteractionMode] = useState<InteractionMode>(() => {
    try {
      return sessionStorage.getItem("ionize-interaction") === "drag" ? "drag" : "rotate";
    } catch {
      return "rotate";
    }
  });
  const interactionModeRef = useRef(interactionMode);
  useEffect(() => {
    interactionModeRef.current = interactionMode;
    try {
      sessionStorage.setItem("ionize-interaction", interactionMode);
    } catch {
      /* ignore */
    }
  }, [interactionMode]);

  // Starlink density (drawn count) + brightness — fx4 defaults
  const [starlinkDensity, setStarlinkDensity] = useState(2200);
  const starlinkDensityRef = useRef(starlinkDensity);
  useEffect(() => {
    starlinkDensityRef.current = starlinkDensity;
  }, [starlinkDensity]);
  const [starlinkBrightness, setStarlinkBrightness] = useState(0.42);
  const starlinkBrightnessRef = useRef(starlinkBrightness);
  useEffect(() => {
    starlinkBrightnessRef.current = starlinkBrightness;
  }, [starlinkBrightness]);
  const [starlinkDrawn, setStarlinkDrawn] = useState(0);

  // Day-hemisphere brightness (shader uDayBoost) — user t104u
  const [dayBrightness, setDayBrightness] = useState(1.35);
  const [sunMode, setSunMode] = useState<"photo" | "live">("photo");
  const [sunAzimuth, setSunAzimuth] = useState(0);
  const sunLightingRef = useRef<SunLighting>({ mode: "photo", azimuth: 0 });
  useEffect(() => {
    sunLightingRef.current = sunMode === "live" ? { mode: "live" } : { mode: "photo", azimuth: sunAzimuth };
  }, [sunMode, sunAzimuth]);
  const dayBrightnessRef = useRef(dayBrightness);
  useEffect(() => {
    dayBrightnessRef.current = dayBrightness;
  }, [dayBrightness]);

  const [starlinkStats, setStarlinkStats] = useState<StarlinkStats | null>(null);
  const [starlinkError, setStarlinkError] = useState<string | null>(null);
  const [starlinkLoading, setStarlinkLoading] = useState(false);
  const starlinkLoadedRef = useRef(false);

  const positions = useRef<Map<string, LatLngMarker>>(new Map());
  const socketIdRef = useRef<string | null>(null);

  const socketIdLiveRef = useRef<string | null>(null);
  const onPartyMessage = useRef<(evt: MessageEvent) => void>(() => {});
  onPartyMessage.current = (evt: MessageEvent) => {
    const message = JSON.parse(evt.data as string) as OutgoingMessage;
    if (message.type === "add-marker") {
      const pos = message.position;
      if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return;
      const sid = socketIdLiveRef.current;
      positions.current.set(pos.id, {
        id: pos.id,
        lat: pos.lat,
        lng: pos.lng,
        size: pos.id === sid ? 0.12 : 0.08,
        self: pos.id === sid,
      });
      setCounter(positions.current.size);
    } else if (message.type === "remove-marker") {
      positions.current.delete(message.id);
      setCounter(positions.current.size);
    }
  };

  const socket = usePartySocket({
    room: "default",
    party: "globe",
    onMessage(evt) {
      onPartyMessage.current(evt as MessageEvent);
    },
  });
  socketIdLiveRef.current = socket.id;
  socketIdRef.current = socket.id;

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

  // Keep WebGL alive across React re-renders / StrictMode / dashboard polls.
  // Destroying here caused Alan fx5 ~10s delayed snap-back to default pose.
  useEffect(() => {
    const canvas = canvasRef.current as HTMLCanvasElement | undefined;
    if (!canvas) return;
    if (globeApiRef.current) return; // already running — do not recreate

    const globe = createGlobeThree({
      canvas,
      getRotationSpeed: () => rotationSpeedRef.current,
      getCloudAmount: () => cloudAmountRef.current,
      getMarkers: () => [...positions.current.values()],
      getTle: () => tleRef.current,
      onIssUpdate: (iss) => {
        setLiveIss((prev) => {
          if (
            prev &&
            iss &&
            Math.abs(prev.latitude - iss.latitude) < 1e-4 &&
            Math.abs(prev.longitude - iss.longitude) < 1e-4
          ) {
            return prev;
          }
          return iss;
        });
      },
      getShowIss: () => showIssRef.current,
      getShowStarlink: () => showStarlinkRef.current,
      getStarlinkDensity: () => starlinkDensityRef.current,
      getStarlinkBrightness: () => starlinkBrightnessRef.current,
      getDayBrightness: () => dayBrightnessRef.current,
      getSunLighting: () => sunLightingRef.current,
      getInteractionMode: () => interactionModeRef.current,
    });
    globeApiRef.current = globe;
    // no cleanup destroy — pagehide below
  }, []);

  useEffect(() => {
    const onHide = () => {
      const g = globeApiRef.current;
      if (!g) return;
      globeApiRef.current = null;
      g.destroy();
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  // Satellite masks: refresh metadata without re-decoding an unchanged image.
  useEffect(() => {
    const globe = globeApiRef.current;
    if (!globe) return;
    let cancelled = false;
    let busy = false;
    const controller = new AbortController();

    async function applyLive() {
      if (busy) return;
      busy = true;
      if (!cloudLoadedRef.current) setCloudStatus("加载卫星云图…");
      try {
        const res = await fetch(`/api/clouds?width=${cloudWidth}`, { signal: controller.signal });
        const meta = await res.json() as CloudMetaPayload | { ok: false; error?: string };
        if (!res.ok || !meta.ok) throw new Error("Cloud provider unavailable");
        if (cancelled) return;
        const result = await globe!.setCloudSource({ mode: "live", url: meta.texturePath, revision: meta.revision });
        if (cancelled || result.error === "stale") return;
        if (!result.ok) throw new Error(result.error);
        cloudLoadedRef.current = true;
        setCloudMeta(meta);
        setCloudStatus(`${meta.width === 4096 ? "4K" : "2K"} 卫星云层 · 约 3 小时更新`);
      } catch (e) {
        if (cancelled) return;
        console.warn("live clouds failed", e);
        if (cloudLoadedRef.current) {
          setCloudStatus("刷新失败，保留上一张卫星云图");
        } else {
          await globe!.setCloudSource({ mode: "animated" });
          if (!cancelled) setCloudStatus("卫星云图暂不可用，显示动画云；稍后自动重试");
        }
      } finally { busy = false; }
    }

    if (cloudMode === "animated") {
      cloudLoadedRef.current = false;
      setCloudMeta(null);
      setCloudStatus("装饰动画云 · 非当前天气");
      void globe.setCloudSource({ mode: "animated" });
      return () => { cancelled = true; controller.abort(); };
    }
    void applyLive();
    const timer = setInterval(applyLive, 15 * 60 * 1000);
    const refreshOnReturn = () => { if (!document.hidden) void applyLive(); };
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [cloudMode, cloudWidth]);

  // Starlink catalog via Worker proxy — load when layer enabled (retry + always clear loading)
  useEffect(() => {
    if (!showStarlink) {
      globeApiRef.current?.setStarlinkTles(null);
      setStarlinkLoading(false);
      setStarlinkError(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const ac = new AbortController();

    async function loadOnce(attempt: number): Promise<boolean> {
      const res = await fetch("/api/starlink?tles=1&max=8000", {
        signal: ac.signal,
      });
      const data = (await res.json()) as
        | (StarlinkStats & { tles: StarlinkTlePair[]; drawn?: number })
        | { ok: false; error?: string };
      if (!res.ok || !("ok" in data) || data.ok !== true) {
        throw new Error(
          "error" in data && data.error ? String(data.error) : `starlink → ${res.status}`,
        );
      }
      if (cancelled) return false;
      const tles = data.tles || [];
      if (!tles.length) throw new Error("starlink empty tles");
      setStarlinkStats({
        ok: true,
        count: data.count,
        source: data.source,
        fetchedAt: data.fetchedAt,
        note:
          ("note" in data && data.note) ||
          (data.drawn != null ? `drawing ${data.drawn}` : undefined),
      });
      // Yield so StrictMode / paint can settle before heavy satrec parse
      await new Promise((r) => setTimeout(r, 0));
      if (cancelled) return false;
      globeApiRef.current?.setStarlinkTles(tles);
      starlinkLoadedRef.current = true;
      setStarlinkError(null);
      return true;
    }

    async function load() {
      setStarlinkLoading(true);
      setStarlinkError(null);
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (cancelled) break;
        try {
          const ok = await loadOnce(attempt);
          if (ok || cancelled) {
            lastErr = null;
            break;
          }
        } catch (e) {
          lastErr = e;
          console.warn(`starlink load attempt ${attempt} failed`, e);
          if (cancelled || ac.signal.aborted) break;
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
      if (!cancelled) {
        if (lastErr) {
          setStarlinkError(String(lastErr));
          globeApiRef.current?.setStarlinkTles(null);
        }
        setStarlinkLoading(false);
      }
    }

    void load();
    timer = setInterval(load, 30 * 60 * 1000);
    return () => {
      cancelled = true;
      ac.abort();
      if (timer) clearInterval(timer);
      setStarlinkLoading(false);
    };
  }, [showStarlink]);

  // Reflect live drawn count from globe (density slider)
  useEffect(() => {
    if (!showStarlink) {
      setStarlinkDrawn(0);
      return;
    }
    const id = window.setInterval(() => {
      const n = globeApiRef.current?.getStarlinkDrawn?.() ?? 0;
      setStarlinkDrawn(n);
    }, 500);
    return () => clearInterval(id);
  }, [showStarlink, starlinkDensity]);

    // Stats-only prefetch so panel can show count even before enabling layer
  useEffect(() => {
    let cancelled = false;
    async function peek() {
      try {
        const res = await fetch("/api/starlink?tles=0");
        const data = (await res.json()) as StarlinkStats | { ok: false; error?: string };
        if (!res.ok || !("ok" in data) || data.ok !== true) return;
        if (!cancelled) {
          setStarlinkStats({
            ok: true,
            count: data.count,
            source: data.source,
            fetchedAt: data.fetchedAt,
          });
        }
      } catch {
        /* optional peek */
      }
    }
    void peek();
    return () => {
      cancelled = true;
    };
  }, []);

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
            <p className="tagline">Live globe · ISS · Starlink · markets</p>
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
              <p className="hint">
                {showIss
                  ? "Cyan orbit · TLE/SGP4 · dims when behind Earth"
                  : "ISS layer off — enable in Controls"}
              </p>
            </section>
          ) : (
            <section className="card error-card">
              <h2>ISS Tracker</h2>
              <p>Orbit feed offline</p>
            </section>
          )}

          <section className="card starlink-card">
            <div className="card-head">
              <h2>Starlink</h2>
              <span className="chip">{showStarlink ? "layer on" : "layer off"}</span>
            </div>
            {starlinkLoading && !starlinkStats ? (
              <p className="hint">Loading Celestrak catalog…</p>
            ) : starlinkStats ? (
              <div className="iss-stats">
                <div>
                  <span className="muted">Catalog sats</span>
                  <strong>{starlinkStats.count.toLocaleString()}</strong>
                </div>
                <div>
                  <span className="muted">Source</span>
                  <strong className="cap" style={{ fontSize: "0.78rem" }}>
                    {starlinkStats.source}
                  </strong>
                </div>
                <div>
                  <span className="muted">Fetched</span>
                  <strong>
                    {new Intl.DateTimeFormat("en-GB", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                      timeZone: "Asia/Singapore",
                    }).format(new Date(starlinkStats.fetchedAt))}{" "}
                    SGT
                  </strong>
                </div>
              </div>
            ) : (
              <p className="hint">Stats unavailable{starlinkError ? ` · ${starlinkError}` : ""}</p>
            )}
            {showStarlink ? (
              <div className="starlink-sliders">
                <label htmlFor="starlinkDensity">
                  Density <b>{starlinkDrawn || starlinkDensity}</b>
                  <span className="muted"> / target {starlinkDensity}</span>
                </label>
                <input
                  id="starlinkDensity"
                  type="range"
                  min={500}
                  max={8000}
                  step={100}
                  value={starlinkDensity}
                  onChange={(e) => setStarlinkDensity(parseInt(e.target.value, 10))}
                />
                <label htmlFor="starlinkBright">
                  Brightness <b>{Math.round(starlinkBrightness * 100)}%</b>
                </label>
                <input
                  id="starlinkBright"
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.01}
                  value={starlinkBrightness}
                  onChange={(e) => setStarlinkBrightness(parseFloat(e.target.value))}
                />
              </div>
            ) : null}
            <p className="hint">
              {showStarlink
                ? `Drawing ${starlinkDrawn || "…"} pts · bright ${Math.round(starlinkBrightness * 100)}% · chunked SGP4`
                : "Enable Starlink in Controls · density & brightness sliders appear here"}
              {starlinkLoading ? " · updating…" : ""}
              {starlinkError ? ` · ${starlinkError}` : ""}
            </p>
          </section>
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
            <span className="legend-dot iss" /> ISS
            <span className="legend-dot visitor" /> visitors
            <span className="legend-dot starlink" /> Starlink
            <span className="legend-dot sun" /> Sun
          </div>

          <div className="speed-control card inline-card controls-row">
            <div className="control-block">
              <span className="cloud-mode-label">交互模式</span>
              <div className="segmented" role="group" aria-label="交互模式">
                <button
                  type="button"
                  className={interactionMode === "rotate" ? "seg active" : "seg"}
                  onClick={() => setInteractionMode("rotate")}
                >
                  自转
                </button>
                <button
                  type="button"
                  className={interactionMode === "drag" ? "seg active" : "seg"}
                  onClick={() => setInteractionMode("drag")}
                >
                  拖拽
                </button>
              </div>
              <p className="cloud-status" style={{ opacity: 0.75 }}>
                {interactionMode === "drag"
                  ? "拖拽旋转地球 · 松手有惯性 · 自转暂停"
                  : "自动缓转 · 可调速度"}
              </p>
            </div>
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
                disabled={interactionMode === "drag"}
                onChange={(e) => setRotationSpeed(parseFloat(e.target.value))}
              />
            </div>
            <div className="control-block">
              <span className="cloud-mode-label" title={GLOBE_FX_BUILD}>图层</span>
              <div className="layer-toggles">
                <label className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={showIss}
                    onChange={(e) => setShowIss(e.target.checked)}
                  />
                  <span>ISS</span>
                </label>
                <label className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={showStarlink}
                    onChange={(e) => setShowStarlink(e.target.checked)}
                  />
                  <span>Starlink</span>
                </label>
              </div>
              {showStarlink ? (
                <div className="starlink-sliders compact">
                  <label htmlFor="starlinkDensityCtrl">
                    SL density <b>{starlinkDensity}</b>
                  </label>
                  <input
                    id="starlinkDensityCtrl"
                    type="range"
                    min={500}
                    max={8000}
                    step={100}
                    value={starlinkDensity}
                    onChange={(e) => setStarlinkDensity(parseInt(e.target.value, 10))}
                  />
                  <label htmlFor="starlinkBrightCtrl">
                    SL brightness <b>{Math.round(starlinkBrightness * 100)}%</b>
                  </label>
                  <input
                    id="starlinkBrightCtrl"
                    type="range"
                    min={0.05}
                    max={1}
                    step={0.01}
                    value={starlinkBrightness}
                    onChange={(e) => setStarlinkBrightness(parseFloat(e.target.value))}
                  />
                </div>
              ) : null}
            </div>
            <div className="control-block">
              <div className="sun-control-head">
                <label htmlFor="sunAzimuthRange">太阳方位 <b>{sunMode === "live" ? "实时" : `${sunAzimuth > 0 ? "+" : ""}${sunAzimuth}°`}</b></label>
                <button type="button" className="sun-reset" onClick={() => { setSunAzimuth(0); setSunMode("photo"); }} aria-label="复位太阳方位为正面全亮">↺ 复位</button>
              </div>
              <div className="segmented sun-modes" role="group" aria-label="太阳照明模式">
                <button type="button" className={sunMode === "photo" ? "seg active" : "seg"} aria-pressed={sunMode === "photo"} onClick={() => setSunMode("photo")}>摄影布光</button>
                <button type="button" className={sunMode === "live" ? "seg active" : "seg"} aria-pressed={sunMode === "live"} onClick={() => setSunMode("live")}>真实太阳</button>
              </div>
              <input id="sunAzimuthRange" type="range" min={-180} max={180} step={1} value={sunAzimuth} disabled={sunMode === "live"} aria-describedby="sunLightingHint" aria-valuetext={`${sunAzimuth}度，${Math.abs(sunAzimuth) < 15 ? "正面全亮" : Math.abs(sunAzimuth) > 165 ? "背光" : "侧光"}`} onChange={(e) => setSunAzimuth(Number(e.target.value))} />
              <div className="sun-range-labels" aria-hidden="true"><span>−180° 背光</span><span>0° 全亮</span><span>+180° 背光</span></div>
              <p id="sunLightingHint" className="cloud-status">{sunMode === "photo" ? "相对当前视角布光 · ±90° 侧光 · 不代表实际昼夜" : "按当前时间计算太阳方向 · 复位可返回正面全亮"}</p>
            </div>
            <div className="control-block">
              <label htmlFor="dayBrightRange">
                昼侧亮度 <b>{dayBrightness.toFixed(2)}</b>
              </label>
              <input
                id="dayBrightRange"
                type="range"
                min="0.9"
                max="2.2"
                step="0.05"
                value={dayBrightness}
                onChange={(e) => setDayBrightness(parseFloat(e.target.value))}
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
                  onClick={() => {
                    if (cloudMode === "animated") return;
                    setCloudMode("animated");
                    setCloudStatus("");
                    setCloudMeta(null);
                  }}
                >
                  动画云图
                </button>
                <button
                  type="button"
                  className={cloudMode === "live" ? "seg active" : "seg"}
                  onClick={() => {
                    if (cloudMode === "live") return;
                    setCloudMode("live");
                    setCloudAmount(0.55);
                    setCloudStatus("加载卫星云图…");
                  }}
                >
                  卫星云图
                </button>
              </div>
              {cloudStatus ? (
                <p
                  className={
                    cloudStatus.includes("失败") || cloudStatus.includes("不可用")
                      ? "cloud-status is-error"
                      : "cloud-status"
                  }
                  title={LIVE_CLOUDS_BUILD}
                >
                  {cloudStatus}
                </p>
              ) : null}
              {cloudMode === "live" ? (
                <>
                  <div className="segmented" role="group" aria-label="卫星云图清晰度">
                    {[2048, 4096].map((width) => (
                      <button type="button" key={width} aria-pressed={cloudWidth === width}
                        className={cloudWidth === width ? "seg active" : "seg"}
                        onClick={() => {
                          if (cloudWidth === width) return;
                          setCloudWidth(width); setCloudStatus("切换云图清晰度…");
                        }}>
                        {width === 2048 ? "2K · 省流量" : "4K · 精细云层"}
                      </button>
                    ))}
                  </div>
                  <p className="cloud-status" style={{ opacity: 0.75 }}>
                    保留气旋云系结构；缺测与极区不补造云。更新时柔和过渡，云系不做虚构漂移。
                  </p>
                  <p className="cloud-status" style={{ opacity: 0.75 }}>
                    观测时刻：上游未提供{cloudMeta ? ` · 最近检查 ${new Date(cloudMeta.checkedAt).toISOString().slice(11, 16)} UTC` : ""}
                  </p>
                  <p className="cloud-status" style={{ opacity: 0.75 }}>
                    <a href="https://github.com/matteason/live-cloud-maps" target="_blank" rel="noreferrer">EUMETSAT / Live Cloud Maps</a>
                    <br />Contains modified EUMETSAT data
                  </p>
                </>
              ) : null}
            </div>
          </div>
        </section>

        <aside className="rail right-rail">
          <section className="card markets-card">
            <div className="card-head">
              <h2>Markets</h2>
              <span className="chip">
                {data?.markets?.some((m) => m.kind === "futures")
                  ? "Yahoo · futures"
                  : "Yahoo · 1D"}
              </span>
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
                          <div className="market-symbol">
                            {m.symbol}
                            {m.kind === "futures" ? (
                              <span className="fut-tag"> FUT</span>
                            ) : null}
                          </div>
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
          <a href="https://npmjs.com/package/partyserver/">PartyServer</a>, Celestrak TLE (ISS + Starlink),
          Open-Meteo, WhereTheISS.at & Yahoo Finance · Earth: NASA Blue Marble · clouds: animated webgl-earth / near-realtime NASA GIBS true-color → cloud mask
        </span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
