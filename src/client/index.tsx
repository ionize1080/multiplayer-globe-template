import "./styles.css";

import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import createGlobe from "cobe";
import usePartySocket from "partysocket/react";

// The type of messages we'll be receiving from the server
import type { OutgoingMessage } from "../shared";
import type { LegacyRef } from "react";

function App() {
  // A reference to the canvas element where we'll render the globe
  const canvasRef = useRef<HTMLCanvasElement>();
  // Current zoom level of the globe
  const [zoom, setZoom] = useState(1);
  // The number of markers we're currently displaying
  const [counter, setCounter] = useState(0);
  // Rotation speed of the globe
  const [rotationSpeed, setRotationSpeed] = useState(0.01);
  const rotationSpeedRef = useRef(rotationSpeed);
  useEffect(() => {
    rotationSpeedRef.current = rotationSpeed;
  }, [rotationSpeed]);

  // Location and weather information
  const [location, setLocation] = useState<{
    city: string;
    latitude: number;
    longitude: number;
  } | null>(null);
  const [weather, setWeather] = useState<{
    temperature: number;
    description: string;
  } | null>(null);

  useEffect(() => {
    async function loadLocation() {
      try {
        const res = await fetch("/api/location");
        if (!res.ok) return;
        const data = await res.json();
        setLocation({
          city: data.city,
          latitude: parseFloat(data.latitude),
          longitude: parseFloat(data.longitude),
        });

        const weatherRes = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${data.latitude}&longitude=${data.longitude}&current_weather=true&timezone=auto`,
        );
        if (!weatherRes.ok) return;
        const weatherData = await weatherRes.json();

        const code = weatherData.current_weather.weathercode as number;
        const descriptions: Record<number, string> = {
          0: "Clear",
          1: "Mainly clear",
          2: "Partly cloudy",
          3: "Overcast",
          45: "Fog",
          48: "Fog",
          51: "Drizzle",
          53: "Drizzle",
          55: "Drizzle",
          56: "Freezing drizzle",
          57: "Freezing drizzle",
          61: "Rain",
          63: "Rain",
          65: "Rain",
          66: "Freezing rain",
          67: "Freezing rain",
          71: "Snow",
          73: "Snow",
          75: "Snow",
          77: "Snow grains",
          80: "Rain showers",
          81: "Rain showers",
          82: "Rain showers",
          85: "Snow showers",
          86: "Snow showers",
          95: "Thunderstorm",
          96: "Thunderstorm",
          99: "Thunderstorm",
        };

        setWeather({
          temperature: weatherData.current_weather.temperature,
          description: descriptions[code] || "Unknown",
        });
      } catch (err) {
        console.error(err);
      }
    }

    loadLocation();
  }, []);
  // A map of marker IDs to their positions
  // Note that we use a ref because the globe's `onRender` callback
  // is called on every animation frame, and we don't want to re-render
  // the component on every frame.
  const positions = useRef<
    Map<
      string,
      {
        location: [number, number];
        size: number;
      }
    >
  >(new Map());
  // Connect to the PartyServer server
  const socket = usePartySocket({
    room: "default",
    party: "globe",
    onMessage(evt) {
      const message = JSON.parse(evt.data as string) as OutgoingMessage;
      if (message.type === "add-marker") {
        // Add the marker to our map
        positions.current.set(message.position.id, {
          location: [message.position.lat, message.position.lng],
          size: message.position.id === socket.id ? 0.1 : 0.05,
        });
        // Update the counter
        setCounter((c) => c + 1);
      } else {
        // Remove the marker from our map
        positions.current.delete(message.id);
        // Update the counter
        setCounter((c) => c - 1);
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
        return Math.min(3, Math.max(0.5, next));
      });
    };
    canvas.addEventListener("wheel", handleWheel);
    return () => {
      canvas.removeEventListener("wheel", handleWheel);
    };
  }, []);

  useEffect(() => {
    // The angle of rotation of the globe
    // We'll update this on every frame to make the globe spin
    let phi = 0;

    const globe = createGlobe(canvasRef.current as HTMLCanvasElement, {
      devicePixelRatio: 2,
      width: 400 * 2,
      height: 400 * 2,
      phi: 0,
      theta: 0,
      dark: 1,
      diffuse: 0.8,
      mapSamples: 16000,
      mapBrightness: 6,
      baseColor: [0.3, 0.3, 0.3],
      markerColor: [0.8, 0.1, 0.1],
      glowColor: [0.2, 0.2, 0.2],
      markers: [],
      opacity: 0.7,
      onRender: (state) => {
        // Called on every animation frame.
        // `state` will be an empty object, return updated params.

        // Get the current positions from our map
        state.markers = [...positions.current.values()];

        // Rotate the globe
        state.phi = phi;
        phi += rotationSpeedRef.current;
      },
    });

    return () => {
      globe.destroy();
    };
  }, []);

  return (
    <div className="App">
      <h1>Where's everyone at?</h1>
      {counter !== 0 ? (
        <p>
          <b>{counter}</b> {counter === 1 ? "person" : "people"} connected.
        </p>
      ) : (
        <p>&nbsp;</p>
      )}

      <div className="speed-control">
        <label htmlFor="speedRange">Rotation Speed: {rotationSpeed.toFixed(2)}</label>
        <input
          id="speedRange"
          type="range"
          min="0"
          max="0.05"
          step="0.001"
          value={rotationSpeed}
          onChange={(e) => setRotationSpeed(parseFloat(e.target.value))}
        />
      </div>

      {/* The canvas where we'll render the globe */}
      <canvas
        ref={canvasRef as LegacyRef<HTMLCanvasElement>}
        style={{
          width: 400,
          height: 400,
          maxWidth: "100%",
          aspectRatio: 1,
          transform: `scale(${zoom})`,
        }}
      />

      {/* Let's give some credit */}
      <p>
        Powered by <a href="https://cobe.vercel.app/">🌏 Cobe</a>,{" "}
        <a href="https://www.npmjs.com/package/phenomenon">Phenomenon</a> and{" "}
        <a href="https://npmjs.com/package/partyserver/">🎈 PartyServer</a>
      </p>

      {location && weather && (
        <div className="weather-bar">
          {location.city && <span>{location.city}&nbsp;</span>}
          <span>
            {weather.temperature.toFixed(1)}°C, {weather.description}
          </span>
        </div>
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.getElementById("root")!).render(<App />);
