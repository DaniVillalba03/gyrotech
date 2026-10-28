"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GyroStreamParser, type GyroSample } from "@/lib/gyroParser";

export type SerialStatus = "idle" | "connecting" | "connected" | "error";

export interface SerialStats {
  bytes: number;
  samples: number;
  lastText: string;
  last: GyroSample | null;
  applied: number;
  hz: number;
  calibrated: boolean;
}

export function useSerialGyro() {
  const [status, setStatus] = useState<SerialStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<SerialStats>({ bytes: 0, samples: 0, lastText: "", last: null, applied: 0, hz: 0, calibrated: false });
  // Última muestra y contador: se leen desde useFrame sin provocar renders.
  const latest = useRef<{
    sample: GyroSample | null;
    seq: number;
    applied?: number;
    calibrated?: boolean;
    queue: { t: number; s: GyroSample }[];
  }>({ sample: null, seq: 0, queue: [] });
  const statsRef = useRef<SerialStats>({ bytes: 0, samples: 0, lastText: "", last: null, applied: 0, hz: 0, calibrated: false });
  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const closingRef = useRef(false);
  const times = useRef<number[]>([]);

  // Intervalo medio (s) entre las últimas lecturas; 0 si aún no hay dos.
  const calcInterval = () => {
    const t = times.current;
    if (t.length < 2) return 0;
    return (t[t.length - 1] - t[0]) / 1000 / (t.length - 1);
  };

  // Refresca el panel de diagnóstico 4 veces por segundo mientras hay conexión.
  useEffect(() => {
    if (status !== "connected") return;
    const id = setInterval(() => setStats({ ...statsRef.current, applied: latest.current.applied ?? 0, hz: calcInterval(), calibrated: latest.current.calibrated ?? false }), 250);
    return () => clearInterval(id);
  }, [status]);

  const disconnect = useCallback(async () => {
    closingRef.current = true;
    try {
      await readerRef.current?.cancel();
    } catch {}
  }, []);

  const connect = useCallback(async () => {
    if (!("serial" in navigator)) {
      setError("Este navegador no soporta Web Serial. Usa Chrome o Edge.");
      setStatus("error");
      return;
    }

    let port: SerialPort;
    try {
      port = await navigator.serial.requestPort();
    } catch {
      return; // el usuario cerró el selector
    }

    closingRef.current = false;
    setError(null);
    setStatus("connecting");
    statsRef.current = { bytes: 0, samples: 0, lastText: "", last: null, applied: 0, hz: 0, calibrated: false };
    latest.current = { sample: null, seq: 0, queue: [] };
    times.current = [];

    try {
      await port.open({ baudRate: 115200, bufferSize: 65536 });
      try {
        await port.setSignals({ dataTerminalReady: true, requestToSend: true });
      } catch {}
      portRef.current = port;
      setStatus("connected");

      const decoder = new TextDecoder();
      const parser = new GyroStreamParser();

      // Si hay un error de lectura recuperable, se vuelve a pedir un reader (patrón recomendado de Web Serial).
      while (port.readable && !closingRef.current) {
        const reader = port.readable.getReader();
        readerRef.current = reader;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            const text = decoder.decode(value, { stream: true });
            const st = statsRef.current;
            st.bytes += value.length;
            st.lastText = (st.lastText + text).slice(-600);
            for (const s of parser.push(text)) {
              latest.current.sample = s;
              latest.current.queue.push({ t: performance.now() / 1000, s });
              if (latest.current.queue.length > 5000) latest.current.queue.shift();
              latest.current.seq++;
              st.samples++;
              times.current.push(performance.now());
              if (times.current.length > 10) times.current.shift();
              st.last = s;
            }
          }
        } catch (e) {
          console.warn("Error de lectura serial (se reintenta):", e);
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          reader.releaseLock();
          readerRef.current = null;
        }
        if (closingRef.current) break;
        // Pausa corta antes de reintentar para no entrar en un bucle apretado.
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
      portRef.current = null;
      try {
        await port.close();
      } catch {}
      return;
    }

    try {
      await port.close();
    } catch {}
    portRef.current = null;
    setStatus("idle");
  }, []);

  useEffect(() => {
    return () => {
      closingRef.current = true;
      readerRef.current?.cancel().catch(() => {});
    };
  }, []);

  return { status, error, stats, latest, connect, disconnect };
}
