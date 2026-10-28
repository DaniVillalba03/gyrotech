# Gyrotech — cohete 3D con giroscopio USB

Página Next.js que muestra un cohete 3D (URUTAÚ III) y lo hace girar en tiempo real con los datos
del giroscopio de la placa Arandu (STM32F722), leídos por USB serie desde el navegador.

## Uso

```bash
npm install
npm run dev
```

Abre http://localhost:3000 en **Chrome o Edge** (usa la Web Serial API, que solo funciona en
`localhost` o HTTPS). Pulsa **Conectar**, elige el puerto COM de la placa y deja la placa quieta unos
segundos hasta que la tarjeta diga "Enlace activo". **Calibrar (R)** vuelve a poner el origen.

## Datos esperados

Una línea de texto por lectura, con el giroscopio en grados/s:

```
Giroscopio (grados/s):     X 1.23   Y -4.56   Z 7.89
Gyro[dps]: X=-3.2 Y=-2.0 Z=-1.3
```

Ambos formatos se reconocen (`src/lib/gyroParser.ts`). Para un seguimiento fluido el firmware debe
enviar la línea a ~60 Hz: `firmware/Task_Monitor.cpp` es el `Task_Monitor.cpp` del firmware con ese cambio.

## Estructura

- `src/app/page.tsx` — pantalla, controles y tarjeta de telemetría.
- `src/hooks/useSerialGyro.ts` — conexión Web Serial y lectura de líneas.
- `src/lib/gyroParser.ts` — análisis de las líneas del giroscopio.
- `src/components/RocketScene.tsx` — escena 3D, modelo GLB, calibración e integración del giro.
- `public/cohete.glb` — modelo del cohete.

## Ajustes útiles (`src/components/RocketScene.tsx`)

- `AXIS_MAP` — qué eje del sensor mueve cada eje del cohete (según cómo esté montada la placa).
- `GAIN` — sensibilidad del giro.
- `FACE_Y` — lado del cohete que mira a la cámara al inicio.
- `NOSE_FRACTION` — largo de la ojiva roja.
