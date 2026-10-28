"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useSerialGyro } from "@/hooks/useSerialGyro";
import styles from "./page.module.css";

const RocketScene = dynamic(() => import("@/components/RocketScene"), { ssr: false });

const fmt = (n: number | undefined) => (n === undefined ? "—" : n.toFixed(2));

export default function Home() {
  const { status, error, stats, latest, connect, disconnect } = useSerialGyro();
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "r") setResetKey((k) => k + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const connected = status === "connected";

  return (
    <main className={styles.main}>
      <div className={styles.stage}>
        <RocketScene latest={latest} resetKey={resetKey} />
      </div>

      <div className={styles.flag}>
        <i />
        <i />
        <i />
      </div>

      <header className={styles.header}>
        <div className={styles.brand}>
          <b>ARANDU</b>
          <span>Tech Day · Telemetría</span>
        </div>
        <div className={styles.actions}>
          {error && <span className={styles.error}>{error}</span>}
          <button className={styles.btn} onClick={() => setResetKey((k) => k + 1)}>
            Calibrar (R)
          </button>
          <button
            className={`${styles.btn} ${styles.primary}`}
            onClick={connected ? disconnect : connect}
            disabled={status === "connecting"}
          >
            {connected ? "Desconectar" : "Conectar ↗"}
          </button>
        </div>
      </header>

      <div className={styles.tag}>Actitud en tiempo real</div>

      <aside className={styles.card}>
        <div className={`${styles.status} ${connected ? styles.on : ""}`}>
          <span className={styles.dot} />
          {!connected ? "Sin conexión" : stats.calibrated ? "Enlace activo" : "Calibrando: mantén la placa quieta"}
        </div>
        <div className={styles.cardTitle}>Giroscopio</div>
        <div className={styles.row}>
          <span>Eje X °/s</span>
          <b>{fmt(stats.last?.x)}</b>
        </div>
        <div className={styles.row}>
          <span>Eje Y °/s</span>
          <b>{fmt(stats.last?.y)}</b>
        </div>
        <div className={styles.row}>
          <span>Eje Z °/s</span>
          <b>{fmt(stats.last?.z)}</b>
        </div>
        <div className={styles.row}>
          <span>Ángulo desde el origen</span>
          <b>{stats.applied.toFixed(1)}°</b>
        </div>
        <div className={styles.row}>
          <span>Intervalo entre lecturas</span>
          <b>{stats.hz > 0 ? `${stats.hz.toFixed(2)} s` : "—"}</b>
        </div>
        <div className={styles.row}>
          <span>Lecturas</span>
          <b>{stats.samples}</b>
        </div>
      </aside>

      <footer className={styles.footer}>
        <span>I3G4250D · ±2000 °/s</span>
        <span>Orientación por integración del giroscopio</span>
        <span>USB · Serial</span>
      </footer>
    </main>
  );
}
