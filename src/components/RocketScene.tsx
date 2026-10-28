"use client";

import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { GyroSample } from "@/lib/gyroParser";

type Latest = {
  current: {
    sample: GyroSample | null;
    seq: number;
    applied?: number;
    calibrated?: boolean;
    queue: { t: number; s: GyroSample }[];
  };
};

// Mapeo eje del sensor -> eje de three.js (el cohete apunta a +Y). Ajustar según cómo
// esté montada la placa: cada eje es [índice de eje del sensor (0=X,1=Y,2=Z), signo].
const AXIS_MAP: [number, number][] = [
  [0, 1], // three X <- sensor X
  [2, 1], // three Y <- sensor Z (giro sobre el eje largo del cohete)
  [1, -1], // three Z <- -sensor Y
];

const DEG = Math.PI / 180;
const FILTER = 0.25; // filtro pasa-bajos de las lecturas (1 = sin filtrar): reduce el ruido del sensor
const DEADBAND = 1.5; // °/s: umbral suave en movimiento; se resta de la magnitud para no rectificar el ruido
const BIAS_TRACK = 0.05; // con la placa quieta, el bias converge a la media de las lecturas
const STILL_WINDOW = 60; // lecturas (~1 s a 60 Hz) que se miran para decidir si la placa está quieta
const CALIB_FALLBACK = 300; // lecturas (~5 s): si aún no calibró, se acepta la media si es plausible
const STILL_STD = 6; // °/s: desviación típica máxima (ruido incluido) para considerar quieta la placa
const BIAS_MAX = 10; // °/s: el valor de reposo de un giroscopio nunca es mayor; más que eso es giro real
const BIAS_JUMP = 6; // °/s: el reposo nuevo solo se acepta si queda así de cerca del anterior...
const STILL_FORCE = 180; // ...o si la placa lleva este número de lecturas (~3 s) totalmente constante
const MOVING_NOW = 8; // °/s: una lectura así de lejos del reposo es movimiento, sin esperar la ventana
const GAIN = 1; // sensibilidad: 1 = ángulo real (a 60 Hz ya no hace falta atenuar)
const MAX_GAP_S = 30; // un hueco mayor entre lecturas no se integra (reconexión, pausa)
const PLAY_MAX_S = 0.5; // s: el giro de cada lectura se reparte en como máximo este tiempo
const RATE_TAU = 0.05; // s: suavizado de los cambios de velocidad de giro

function Rocket({ latest, resetKey }: { latest: Latest; resetKey: number }) {
  const group = useRef<THREE.Group>(null);
  const pending = useRef(new THREE.Vector3()); // ángulo (rad) aún por aplicar, vector de rotación
  const rateTarget = useRef(new THREE.Vector3()); // rad/s con que se reparte el ángulo pendiente
  const rate = useRef(new THREE.Vector3()); // rad/s suavizada que realmente se aplica
  const period = useRef(1); // s: periodo medio entre lecturas (se mide solo)
  const bias = useRef(new THREE.Vector3()); // °/s en reposo, se ajusta solo cuando la placa está quieta
  const calibrated = useRef(false); // hasta que la placa esté quieta una vez no se conoce su valor de reposo
  const history = useRef<THREE.Vector3[]>([]);
  const seen = useRef(0);
  const filtered = useRef<THREE.Vector3 | null>(null);
  const stillCount = useRef(0);
  const prev = useRef<{ w: THREE.Vector3; t: number } | null>(null);
  const dq = useRef(new THREE.Quaternion());
  const axis = useRef(new THREE.Vector3());

  useEffect(() => {
    // Calibrar (R) sin haber calibrado todavía: se toma la media reciente como valor de reposo.
    const h = history.current;
    if (resetKey > 0 && !calibrated.current && h.length >= 15) {
      const mean = new THREE.Vector3();
      h.forEach((p) => mean.add(p));
      bias.current.copy(mean.divideScalar(h.length));
      calibrated.current = true;
    }
    group.current?.quaternion.identity();
    pending.current.set(0, 0, 0);
    rateTarget.current.set(0, 0, 0);
    rate.current.set(0, 0, 0);
    history.current = [];
    filtered.current = null;
    stillCount.current = 0;
    prev.current = null;
  }, [resetKey]);

  // Bucle de animación: escribe a propósito en referencias compartidas (sin re-render), por eso se desactiva la regla.
  /* eslint-disable react-hooks/immutability */
  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    const dt = Math.min(delta, 0.1);

    // Se procesan TODAS las lecturas que llegaron desde el cuadro anterior.
    const queue = latest.current.queue.splice(0);
    for (const { t, s } of queue) {
      const raw = [s.x, s.y, s.z];
      const v = new THREE.Vector3(
        ...(AXIS_MAP.map(([i, sign]) => raw[i] * sign) as [number, number, number]),
      );

      // Filtro pasa-bajos: el sensor tiene ruido de unos ±3 °/s lectura a lectura.
      if (!filtered.current) filtered.current = v.clone();
      else filtered.current.lerp(v, FILTER);
      const f = filtered.current;

      // Reposo: ventana de lecturas con poca dispersión y con valor de reposo plausible.
      // Se usan las lecturas sin filtrar para medir bien el ruido.
      const h = history.current;
      h.push(v.clone());
      if (h.length > STILL_WINDOW) h.shift();
      seen.current++;
      let still = false;
      if (h.length === STILL_WINDOW) {
        const mean = new THREE.Vector3();
        for (const p of h) mean.add(p);
        mean.divideScalar(h.length);
        let varSum = 0;
        for (const p of h) varSum += p.distanceToSquared(mean);
        const std = Math.sqrt(varSum / h.length);
        const plausible = mean.length() < BIAS_MAX;
        const flat = std < STILL_STD && plausible;
        stillCount.current = flat ? stillCount.current + 1 : 0;
        if (!calibrated.current) {
          // Primera vez que la placa está quieta: ese es su valor de reposo. Hasta entonces no se mueve nada.
          // Respaldo: tras ~5 s se acepta la media si es plausible, aunque el ruido sea alto.
          if (flat || (seen.current > CALIB_FALLBACK && plausible)) {
            bias.current.copy(mean);
            calibrated.current = true;
          }
        } else {
          still = flat && (mean.distanceTo(bias.current) < BIAS_JUMP || stillCount.current > STILL_FORCE);
          if (still) bias.current.lerp(mean, BIAS_TRACK);
        }
      }

      const e = f.clone().sub(bias.current);
      const mag = e.length();
      let w = new THREE.Vector3();
      if (calibrated.current && (mag > MOVING_NOW || (!still && mag > DEADBAND))) {
        // Umbral suave: se resta DEADBAND de la magnitud, así el ruido no se rectifica en deriva.
        w = e.multiplyScalar(((mag - DEADBAND) / mag) * DEG * GAIN);
      }

      // Integración trapezoidal con el tiempo real entre lecturas: no se pierde ángulo.
      const p = prev.current;
      if (p) {
        const gap = t - p.t;
        if (gap > 0 && gap <= MAX_GAP_S) {
          pending.current.addScaledVector(p.w.clone().add(w), 0.5 * gap);
          period.current += 0.3 * (Math.min(Math.max(gap, 0.01), MAX_GAP_S) - period.current);
          // El ángulo pendiente se reparte a velocidad constante durante el próximo intervalo,
          // así el cohete gira continuo en lugar de saltar en cada lectura.
          rateTarget.current.copy(pending.current).divideScalar(Math.min(period.current, PLAY_MAX_S));
        }
      }
      prev.current = { w, t };
    }

    // Velocidad suavizada hacia la objetivo; nunca se aplica más ángulo del que hay pendiente.
    rate.current.lerp(rateTarget.current, 1 - Math.exp(-dt / RATE_TAU));
    const step = rate.current.clone().multiplyScalar(dt);
    if (step.length() > pending.current.length()) step.copy(pending.current);
    const ang = step.length();
    if (ang > 1e-6) {
      axis.current.copy(step).divideScalar(ang);
      dq.current.setFromAxisAngle(axis.current, ang);
      g.quaternion.multiply(dq.current).normalize();
      pending.current.sub(step);
    }
    latest.current.calibrated = calibrated.current;
    latest.current.applied = (2 * Math.acos(Math.min(1, Math.abs(g.quaternion.w)))) / DEG; // ángulo respecto al origen

  });
  /* eslint-enable react-hooks/immutability */

  return (
    <group ref={group}>
      <RocketModel />
    </group>
  );
}

// Modelo GLB del cohete: se centra y escala solo, y se rota para que su eje largo quede en +Y.
// Si la punta queda hacia abajo, cambiar FLIP a true.
const MODEL_URL = "/cohete.glb";
const MODEL_HEIGHT = 4.6;
const FLIP = false;
const NOSE_FRACTION = 0.16; // parte del largo, desde la punta, que va en rojo
const MAX_WRAP = 1.0; // radianes (~57°) a cada lado: ancho máximo que puede abarcar un logo sobre el tubo
const FACE_Y = Math.PI / 2; // giro sobre el eje vertical para ver el parche de frente


const RED = new THREE.Color("#c4262c");
const BLACK = new THREE.Color("#101216");

// El cuerpo, la ojiva y las aletas del GLB son una sola malla con un solo material. Se pintan por
// zona con colores por vértice: ojiva y aletas en rojo, tubo en negro.
function paintRocket(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  let body: THREE.Mesh | null = null;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
    if (mat.map) return;
    const n = m.geometry.getAttribute("position").count;
    if (!body || n > body.geometry.getAttribute("position").count) body = m;
  });
  const mesh = body as THREE.Mesh | null;
  if (!mesh) return;

  // Pieza interior roja (Círculo): su radio es casi igual al del tubo y asoma como rayas rojas
  // por superposición de superficies. No aporta nada visible: se oculta.
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m === mesh) return;
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
    if (!mat.map) m.visible = false;
  });

  const geo = mesh.geometry.clone();
  const pos = geo.getAttribute("position");
  const pts: THREE.Vector3[] = [];
  const box = new THREE.Box3();
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    pts.push(v);
    box.expandByPoint(v);
  }
  const size = box.getSize(new THREE.Vector3());
  let center = box.getCenter(new THREE.Vector3());
  const ax = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
  const [a1, a2] = ax === 0 ? [1, 2] : ax === 1 ? [0, 2] : [0, 1];
  const len = size.getComponent(ax);
  const lo = box.min.getComponent(ax);
  const radial = (v: THREE.Vector3) => Math.hypot(v.getComponent(a1) - center.getComponent(a1), v.getComponent(a2) - center.getComponent(a2));

  const endR = (lowEnd: boolean) => {
    const r = pts.filter((v) => { const t = (v.getComponent(ax) - lo) / len; return lowEnd ? t < 0.05 : t > 0.95; }).map(radial);
    return r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0;
  };
  const noseAtHigh = endR(false) < endR(true);
  // Eje del cohete: centro de la mitad de la ojiva (sin aletas; las 3 aletas desplazan el centro de la caja).
  const noseHalf = new THREE.Box3();
  pts.forEach((v) => {
    const t = (v.getComponent(ax) - lo) / len;
    if ((noseAtHigh ? 1 - t : t) < 0.5) noseHalf.expandByPoint(v);
  });
  center = noseHalf.getCenter(new THREE.Vector3());

  // Radio del tubo: el radio más frecuente de la malla (el tubo largo casi no tiene vértices a media altura).
  const radii = pts.map(radial);
  const maxR = Math.max(...radii);
  const bin = maxR / 60;
  const hist = new Map<number, number>();
  radii.forEach((r) => {
    if (r < maxR * 0.2) return; // se ignora el eje y la punta
    const k = Math.round(r / bin);
    hist.set(k, (hist.get(k) ?? 0) + 1);
  });
  let tube = maxR;
  let best = 0;
  hist.forEach((count, k) => {
    if (count > best) {
      best = count;
      tube = k * bin;
    }
  });

  // La geometría se lleva al espacio del modelo para que el sombreador use coordenadas del cohete.
  geo.applyMatrix4(mesh.matrixWorld);
  mesh.geometry = geo;
  mesh.removeFromParent();
  mesh.position.set(0, 0, 0);
  mesh.quaternion.identity();
  mesh.scale.set(1, 1, 1);
  mesh.updateMatrix();
  root.add(mesh);

  // Color por píxel (no por vértice): el tubo largo no tiene vértices a media altura y el color se degradaría.
  const axes = "xyz";
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  mats.forEach((m) => {
    const sm = m as THREE.MeshStandardMaterial;
    sm.color.set("#ffffff");
    sm.metalness = 0.15;
    sm.roughness = 0.35;
    sm.onBeforeCompile = (shader) => {
      shader.uniforms.uRed = { value: RED };
      shader.uniforms.uBlack = { value: BLACK };
      shader.uniforms.uCfg = { value: new THREE.Vector4(lo, len, noseAtHigh ? 1 : 0, NOSE_FRACTION) };
      shader.uniforms.uGeo = { value: new THREE.Vector3(tube, center.getComponent(a1), center.getComponent(a2)) };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
          varying vec3 vModelPos;`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          vModelPos = position;`);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec3 vModelPos;
          uniform vec3 uRed;
          uniform vec3 uBlack;
          uniform vec4 uCfg;
          uniform vec3 uGeo;`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          float tt = (vModelPos.${axes[ax]} - uCfg.x) / uCfg.y;
          float fromNose = uCfg.z > 0.5 ? 1.0 - tt : tt;
          float rr = length(vec2(vModelPos.${axes[a1]} - uGeo.y, vModelPos.${axes[a2]} - uGeo.z));
          bool isRed = fromNose < uCfg.w || rr > uGeo.x * 1.12;
          diffuseColor.rgb = isRed ? uRed : uBlack;`,
        );
    };
    sm.needsUpdate = true;
  });
}

// Los detalles del GLB (parche, logos y texto) son planos rectos pegados al costado del cuerpo.
// Se curvan sobre un cilindro del radio real del cohete en esa altura para que se adapten a su
// geometría, conservando las texturas del archivo.
function wrapDecals(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const bodies: THREE.Mesh[] = [];
  const decals: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
    (mat.map ? decals : bodies).push(m);
  });
  if (!bodies.length) return;

  const bodyBox = new THREE.Box3();
  bodies.forEach((b) => bodyBox.expandByObject(b));
  const c = bodyBox.getCenter(new THREE.Vector3());
  const ray = new THREE.Raycaster();
  const v = new THREE.Vector3();

  for (const d of decals) {
    const g = d.geometry.clone();
    const pos = g.getAttribute("position");
    const nrm = g.getAttribute("normal");
    const dc = new THREE.Box3().setFromObject(d).getCenter(new THREE.Vector3());
    const side = dc.x >= c.x ? 1 : -1; // lado del cohete en que está pegado

    // Si la cara frontal del plano mira hacia el eje, el texto se vería espejado: se invierte.
    const front = new THREE.Vector3().fromBufferAttribute(nrm, 0).transformDirection(d.matrixWorld);
    const flip = front.x * side < 0 ? -1 : 1;

    // Radio del cuerpo a la altura del plano: rayo desde afuera hacia el eje.
    ray.set(new THREE.Vector3(c.x + side * 10, dc.y, c.z), new THREE.Vector3(-side, 0, 0));
    const hit = ray.intersectObjects(bodies, false)[0];
    const radius = hit ? Math.abs(hit.point.x - c.x) : Math.abs(dc.x - c.x) * 0.88;
    const r = radius + 0.003; // apenas por encima de la superficie para evitar parpadeos

    // Los planos del archivo son más anchos que el tubo: al curvarlos darían la vuelta y se verían
    // recortados. Se reducen de forma proporcional (sin deformar) para que quepan en la cara visible.
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(d.matrixWorld);
      zMin = Math.min(zMin, v.z);
      zMax = Math.max(zMax, v.z);
    }
    const zMid = (zMin + zMax) / 2;
    const fit = Math.min(1, (MAX_WRAP * r) / ((zMax - zMin) / 2));

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(d.matrixWorld);
      const lat = ((zMid - c.z) + (v.z - zMid) * fit) * flip;
      const th = Math.max(-1.4, Math.min(1.4, lat / r));
      pos.setXYZ(i, c.x + side * r * Math.cos(th), dc.y + (v.y - dc.y) * fit, c.z + r * Math.sin(th));
    }
    g.deleteAttribute("normal");
    g.computeVertexNormals();

    d.geometry = g;
    d.removeFromParent();
    d.position.set(0, 0, 0);
    d.quaternion.identity();
    d.scale.set(1, 1, 1);
    d.updateMatrix();
    root.add(d);

    const mats = Array.isArray(d.material) ? d.material : [d.material];
    mats.forEach((m) => {
      m.polygonOffset = true;
      m.polygonOffsetFactor = -2;
      m.depthWrite = false;
    });
  }
}

function RocketModel() {
  const { scene } = useGLTF(MODEL_URL);
  const model = useMemo(() => {
    const clone = scene.clone(true);
    // El archivo trae una cámara propia que no se necesita.
    clone.traverse((o) => {
      if ((o as THREE.Camera).isCamera) o.visible = false;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Sin mapa de entorno, un material 100 % metálico se ve negro: se baja el metal para ver el color.
      const soften = (m: THREE.Material) => {
        const c = m.clone() as THREE.MeshStandardMaterial;
        if (c.isMeshStandardMaterial) {
          c.metalness = Math.min(c.metalness, 0.1);
          c.roughness = Math.max(c.roughness, 0.45);
        }
        return c;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(soften) : soften(mesh.material);
    });

    paintRocket(clone);
    wrapDecals(clone);

    const holder = new THREE.Group();
    holder.add(clone);

    // Se detecta el eje más largo del modelo y se gira para que quede en +Y.
    const raw = new THREE.Box3().setFromObject(clone).getSize(new THREE.Vector3());
    if (raw.z >= raw.x && raw.z >= raw.y) holder.rotation.x = -Math.PI / 2; // Z -> Y
    else if (raw.x >= raw.y) holder.rotation.z = Math.PI / 2; // X -> Y
    if (FLIP) holder.rotation.z += Math.PI;

    const box = new THREE.Box3().setFromObject(holder);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const k = MODEL_HEIGHT / size.y;

    const root = new THREE.Group();
    root.add(holder);
    // Los detalles (parche y textos) están en un costado del cohete: se gira para que miren a la cámara.
    root.rotation.y = FACE_Y;
    holder.position.sub(center);
    root.scale.setScalar(k);
    return root;
  }, [scene]);

  return <primitive object={model} />;
}

useGLTF.preload(MODEL_URL);

export default function RocketScene({ latest, resetKey }: { latest: Latest; resetKey: number }) {
  return (
    <Canvas flat camera={{ position: [0, 0.5, 7.5], fov: 45 }} dpr={[1, 2]} gl={{ alpha: true }}>
      <hemisphereLight args={["#ffffff", "#8a8f99", 1.0]} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[3, 4, 6]} intensity={1.6} />
      <directionalLight position={[-4, 2, 4]} intensity={0.8} />
      <directionalLight position={[0, -3, -5]} intensity={0.9} />
      <Suspense fallback={null}>
        <Rocket latest={latest} resetKey={resetKey} />
      </Suspense>
    </Canvas>
  );
}
