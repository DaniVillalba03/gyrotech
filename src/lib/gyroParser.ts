export interface GyroSample {
  x: number; // grados/s
  y: number;
  z: number;
}

// Línea del reporte de Task_Monitor.cpp:
//   "  Giroscopio (grados/s):     X 1.23   Y -4.56   Z 7.89"
const GYRO_LINE =
  /Giroscopio \(grados\/s\):\s+X\s+(-?\d+(?:\.\d+)?)\s+Y\s+(-?\d+(?:\.\d+)?)\s+Z\s+(-?\d+(?:\.\d+)?)/;

// Formato del firmware cargado en la placa:
//   "Gyro[dps]: X=-3.2 Y=-2.0 Z=-1.3"
const GYRO_LINE_COMPACT =
  /Gyro\[dps\]:\s*X\s*=\s*(-?\d+(?:\.\d+)?)\s+Y\s*=\s*(-?\d+(?:\.\d+)?)\s+Z\s*=\s*(-?\d+(?:\.\d+)?)/;

export function parseGyroLine(line: string): GyroSample | null {
  const m = GYRO_LINE_COMPACT.exec(line) ?? GYRO_LINE.exec(line);
  if (!m) return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]) };
}

// Acumula fragmentos de texto del puerto serie y emite una muestra por cada línea completa.
export class GyroStreamParser {
  private buffer = "";

  push(chunk: string): GyroSample[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (this.buffer.length > 4096) this.buffer = "";

    const samples: GyroSample[] = [];
    for (const line of lines) {
      const s = parseGyroLine(line);
      if (s) samples.push(s);
    }
    return samples;
  }
}
