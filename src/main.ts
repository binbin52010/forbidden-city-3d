import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildArchitecture, disposeArchitecture } from './architecture';
import { createUI } from './ui';
import type { PalaceData, BuildingRecord, Quality } from './types';
import './style.css';

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const clamp = THREE.MathUtils.clamp;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const roofNames: Record<string, string> = { hipped: '庑殿顶', 'half-hipped': '歇山顶', gabled: '悬山 / 硬山顶', pyramidal: '攒尖顶', round: '圆攒尖顶', flat: '平顶 / 墙体', luding: '盝顶' };

function pointInPolygon(x: number, z: number, polygon: [number, number][]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function footprintArea(record: BuildingRecord) {
  const points = record.footprint;
  if (points.length < 3) return 0;
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    twiceArea += points[i][0] * next[1] - next[0] * points[i][1];
  }
  return Math.abs(twiceArea) * 0.5;
}

function isIrregularCourtyard(record: BuildingRecord) {
  return record.kind === 'building' && record.width * record.depth > 200
    && record.footprint.length >= 6 && footprintArea(record) / (record.width * record.depth) < 0.45;
}

function isWumen(record: BuildingRecord) {
  return /午门|wumen|meridian gate/i.test(`${record.id} ${record.name} ${record.landmark ?? ''}`);
}

function wumenBlocks(record: BuildingRecord, localX: number, localZ: number) {
  const wingX = record.width * 0.405;
  const wingZ = record.depth * 0.07;
  if (Math.abs(Math.abs(localX) - wingX) < record.width * 0.08 + 0.4
    && Math.abs(localZ - wingZ) < record.depth * 0.39 + 0.4) return true;

  const mainZ = -record.depth * 0.29;
  if (Math.abs(localX) >= record.width * 0.5 + 0.4
    || Math.abs(localZ - mainZ) >= record.depth * 0.215 + 0.4) return false;

  // Match the five real openings in architecture.ts; only the ground-level piers block walking.
  const bodyWidth = record.width * 0.91;
  const pier = Math.max(0.55, Math.min(bodyWidth * 0.085, bodyWidth / (5 * 3.2)));
  const opening = (bodyWidth - 6 * pier) / 5;
  for (let i = 0; i <= 5; i++) {
    const pierX = -bodyWidth / 2 + pier / 2 + i * (pier + opening);
    if (Math.abs(localX - pierX) < pier / 2 + 0.4) return true;
  }
  return false;
}

function segmentDistance(x: number, z: number, a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0], dz = b[1] - a[1], length = dx * dx + dz * dz;
  const t = length ? clamp(((x - a[0]) * dx + (z - a[1]) * dz) / length, 0, 1) : 0;
  return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
}

function planarGeometry(points: [number, number][]) {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function pavingTexture() {
  const size = 128, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const seam = y % 32 < 2 || (x + (Math.floor(y / 32) % 2) * 32) % 64 < 2;
    const n = ((x * 193 + y * 71) % 13) - 6, c = seam ? 128 : 187 + n;
    pixels.set([c, c - 4, c - 10, 255], (y * size + x) * 4);
  }
  const t = new THREE.DataTexture(pixels, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(180, 180);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

async function boot() {
  const response = await fetch(`${import.meta.env.BASE_URL}data/palace.json`);
  if (!response.ok) throw new Error(`建筑数据载入失败 (${response.status})`);
  const data: PalaceData = await response.json();
  let selected: BuildingRecord | null = null, quality: Quality = 'auto', labelVisible = true, walking = false;
  let sceneReady = false;
  const ui = createUI(data, {
    select: selectBuilding, overview, top: topView, walk: startWalk,
    quality: (q) => { quality = q; if (sceneReady) { setPixelRatio(); updateLOD(true); } },
    labels: (on) => { labelVisible = on; if (sceneReady) labelLayer.hidden = !on; ui.setLabels(on); },
  });
  ui.loading(0.05, '读取故宫建筑清单');
  const container = document.querySelector<HTMLElement>('#scene')!;
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }); }
  catch { ui.loading(-1, '浏览器未能启用三维图形。请在 Chrome 或 Edge 中启用硬件加速后重新打开。'); return; }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.setAttribute('aria-label', '北京故宫三维建筑群，可拖动旋转、滚轮缩放或选择宫殿');
  renderer.domElement.setAttribute('role', 'img');
  container.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe5e5d8);
  scene.fog = new THREE.FogExp2(0xe5e5d8, 0.00017);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.35, 15000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.minDistance = 8;
  controls.maxDistance = 8500;
  controls.maxPolarAngle = Math.PI / 2 - 0.012;
  controls.screenSpacePanning = false;
  const homeTarget = new THREE.Vector3(0, 12, -30);
  const homePosition = new THREE.Vector3(570, 780, 1180);
  const fittedHome = () => homeTarget.clone().add(homePosition.clone().sub(homeTarget).multiplyScalar(Math.max(1, 1.2 / Math.max(0.38, camera.aspect))));
  camera.position.copy(homePosition);
  controls.target.copy(homeTarget);
  controls.update();
  scene.add(new THREE.HemisphereLight(0xf3f5ec, 0x857364, 1.65));
  const sun = new THREE.DirectionalLight(0xffe4b9, 2.6);
  sun.position.set(-550, 900, 470);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -780, right: 780, top: 780, bottom: -780, near: 1, far: 2100 });
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.55;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xc2d9e3, 0.55);
  fill.position.set(400, 200, -650);
  scene.add(fill);

  const xs = data.boundary.map((p) => p[0]), zs = data.boundary.map((p) => p[1]);
  const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  const wumen = data.buildings.find(isWumen);
  const irregularCourtyardIds = new Set(data.buildings.filter(isIrregularCourtyard).map((b) => b.id));
  const platformTerrain = data.buildings.filter((b) => b.kind === 'platform').map((b) => {
    const c = Math.cos(b.angle), s = Math.sin(b.angle);
    const local = b.footprint.map(([x, z]) => {
      const dx = x - b.center[0], dz = z - b.center[1];
      return [dx * c - dz * s, dx * s + dz * c];
    });
    const crossings: number[] = [];
    for (let i = 0; i < local.length; i++) {
      const a = local[i], next = local[(i + 1) % local.length];
      if ((a[0] <= 0 && next[0] >= 0) || (a[0] >= 0 && next[0] <= 0)) {
        const t = -a[0] / (next[0] - a[0]);
        if (Number.isFinite(t) && t >= 0 && t <= 1) crossings.push(a[1] + (next[1] - a[1]) * t);
      }
    }
    const southZ = crossings.length ? Math.max(...crossings) : Math.max(...local.map((p) => p[1]));
    return { b, c, s, southZ, stairLength: Math.max(1.8, b.height * 1.8) };
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.MeshStandardMaterial({ color: 0x9aab80, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.6;
  scene.add(ground);
  const court = new THREE.Mesh(planarGeometry(data.boundary), new THREE.MeshStandardMaterial({ color: 0xc5bfac, roughness: 0.98, map: pavingTexture() }));
  court.position.y = -0.05;
  court.receiveShadow = true;
  scene.add(court);
  if (wumen) {
    const c = Math.cos(wumen.angle), s = Math.sin(wumen.angle);
    const courtCorners: [number, number][] = [
      [-wumen.width * 0.33, -wumen.depth * 0.08],
      [wumen.width * 0.33, -wumen.depth * 0.08],
      [wumen.width * 0.33, wumen.depth * 0.43],
      [-wumen.width * 0.33, wumen.depth * 0.43],
    ].map(([localX, localZ]): [number, number] => [
      wumen.center[0] + localX * c + localZ * s,
      wumen.center[1] - localX * s + localZ * c,
    ]);
    const courtPaving = new THREE.Mesh(planarGeometry(courtCorners), court.material);
    courtPaving.position.y = -0.04;
    courtPaving.receiveShadow = true;
    scene.add(courtPaving);
  }
  const waterMaterial = new THREE.MeshStandardMaterial({ color: 0x487c7b, metalness: 0.18, roughness: 0.4 });
  for (const area of data.waterAreas ?? data.water.map((outer) => ({ outer, holes: [] }))) {
    const shape = new THREE.Shape(area.outer.map(([x, z]) => new THREE.Vector2(x, -z)));
    for (const hole of area.holes) shape.holes.push(new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, -z))));
    const geometry = new THREE.ShapeGeometry(shape); geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, waterMaterial);
    mesh.position.y = 0.02;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  const waterStrips: THREE.BufferGeometry[] = [];
  for (const line of data.waterLines) for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 0.05) continue;
    const g = new THREE.BoxGeometry(2.2, 0.02, len); g.rotateY(Math.atan2(b[0] - a[0], b[1] - a[1]));
    g.translate((a[0] + b[0]) / 2, 0.015, (a[1] + b[1]) / 2); waterStrips.push(g);
  }
  if (waterStrips.length) { const geometry = mergeGeometries(waterStrips)!; waterStrips.forEach((g) => g.dispose()); scene.add(new THREE.Mesh(geometry, waterMaterial)); }
  addPaths();
  addGardens();

  const byId = new Map(data.buildings.map((b) => [b.id, b]));
  const lowBatches = new Map<string, { material: THREE.Material; parts: THREE.BufferGeometry[] }>();
  const proxyGeometry = new THREE.BoxGeometry(1, 1, 1), proxyMaterial = new THREE.MeshBasicMaterial();
  const proxies: THREE.Mesh[] = [];
  const renderedIds: string[] = [];
  for (let i = 0; i < data.buildings.length; i++) {
    const b = data.buildings[i];
    const low = buildArchitecture(b, 0);
    low.updateMatrixWorld(true);
    low.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const material = object.material as THREE.Material;
      let g = object.geometry.clone();
      g.applyMatrix4(object.matrixWorld);
      if (g.index) { const indexed = g; g = g.toNonIndexed(); indexed.dispose(); }
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
      const key = `${b.zone}|${material.uuid}`;
      if (!lowBatches.has(key)) lowBatches.set(key, { material, parts: [] });
      lowBatches.get(key)!.parts.push(g);
    });
    disposeArchitecture(low);
    renderedIds.push(b.id);
    if (b.kind !== 'wall') {
      const proxy = new THREE.Mesh(proxyGeometry, proxyMaterial);
      proxy.position.set(b.center[0], b.height / 2, b.center[1]);
      proxy.scale.set(b.width, b.height, b.depth);
      proxy.rotation.y = b.angle;
      proxy.userData.id = b.id;
      proxy.updateMatrixWorld(true);
      proxies.push(proxy);
    }
    if (i % 60 === 0) { ui.loading(0.1 + 0.65 * i / data.buildings.length, '搭建宫殿、门廊与城垣'); await frame(); }
  }
  for (const batch of lowBatches.values()) {
    const geometry = mergeGeometries(batch.parts, false);
    batch.parts.forEach((g) => g.dispose());
    if (!geometry) throw new Error('建筑几何合并失败');
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, batch.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  lowBatches.clear();
  addPerimeter();

  const detailCache = new Map<string, { mid: THREE.Group; high?: THREE.Group; used: number }>();
  const activeDetail = new Set<string>();
  const labelLayer = document.createElement('div');
  labelLayer.className = 'scene-label-layer';
  labelLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:3';
  container.append(labelLayer);
  const landmarkLabels: { record: BuildingRecord; element: HTMLButtonElement }[] = [];
  const usedLabels = new Set<string>();
  for (const record of data.buildings) {
    if ((!record.landmark && !/养心殿|慈宁宫|皇极殿|文华殿|武英殿|寿康宫/.test(record.name)) || usedLabels.has(record.name)) continue;
    usedLabels.add(record.name);
    const element = document.createElement('button');
    element.className = 'scene-label';
    element.textContent = record.name;
    element.style.cssText = 'position:absolute;pointer-events:auto;border:1px solid #c0a77988;border-radius:3px;background:#fbf4e5ed;color:#603729;padding:4px 9px;font:12px/1.4 Georgia,"Noto Serif SC",serif;box-shadow:0 2px 8px #37281824;transform:translate(-50%,-100%);cursor:pointer;white-space:nowrap';
    element.onclick = () => selectBuilding(record.id);
    labelLayer.append(element);
    landmarkLabels.push({ record, element });
  }
  const outlineMaterial = new THREE.LineBasicMaterial({ color: 0xffdc91, depthTest: false, transparent: true, opacity: 0.95 });
  let selectionOutline: THREE.LineLoop | undefined;
  let tween: { start: number; from: THREE.Vector3; to: THREE.Vector3; targetFrom: THREE.Vector3; targetTo: THREE.Vector3 } | undefined;
  const raycaster = new THREE.Raycaster();
  let pointerStart = [0, 0], yaw = 0, pitch = 0, draggingWalk = false;
  const keys = new Set<string>();
  const v = new THREE.Vector3(), q = new THREE.Quaternion();
  const visited = new Map<string, number>();

  function setPixelRatio() { renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'high' ? 2 : quality === 'low' ? 1 : 1.5)); renderer.shadowMap.enabled = quality === 'high' || (quality === 'auto' && container.clientWidth >= 700); }
  function resize() {
    const width = container.clientWidth, height = container.clientHeight;
    const previousAspect = camera.aspect;
    camera.aspect = width / Math.max(1, height);
    if (sceneReady && !selected && !walking) {
      const change = Math.max(1, 1.2 / Math.max(0.38, camera.aspect)) / Math.max(1, 1.2 / Math.max(0.38, previousAspect));
      camera.position.sub(controls.target).multiplyScalar(change).add(controls.target);
    }
    if (width >= 900) camera.setViewOffset(width, height, width * 0.085, 0, width, height);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    setPixelRatio();
  }
  new ResizeObserver(resize).observe(container);
  resize();
  controls.addEventListener('start', () => { tween = undefined; });
  renderer.domElement.addEventListener('pointerdown', (e) => { pointerStart = [e.clientX, e.clientY]; draggingWalk = walking; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    draggingWalk = false;
    if (walking || Math.hypot(e.clientX - pointerStart[0], e.clientY - pointerStart[1]) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = raycaster.intersectObjects(proxies, false)[0];
    if (hit) selectBuilding(hit.object.userData.id);
  });
  document.addEventListener('mousemove', (event) => {
    if (!walking || (!document.pointerLockElement && !draggingWalk)) return;
    yaw -= event.movementX * 0.0023;
    pitch = clamp(pitch - event.movementY * 0.0023, -1.1, 1.1);
  });
  window.addEventListener('keydown', (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName ?? '')) return;
    if (e.code === 'Escape' && walking) stopWalk();
    if (walking && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft'].includes(e.code)) { keys.add(e.code); e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  document.addEventListener('pointerlockchange', () => { if (walking && !document.pointerLockElement) keys.clear(); });
  renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); ui.loading(-1, '三维图形连接已中断，请刷新页面重新载入。'); });

  function fly(position: THREE.Vector3, target: THREE.Vector3) {
    stopWalk();
    if (reducedMotion) { camera.position.copy(position); controls.target.copy(target); controls.update(); return; }
    tween = { start: performance.now(), from: camera.position.clone(), to: position, targetFrom: controls.target.clone(), targetTo: target };
  }
  function overview() { if (!sceneReady) return; selected = null; ui.select(null); clearSelection(); fly(fittedHome(), homeTarget.clone()); }
  function topView() { if (!sceneReady) return; fly(new THREE.Vector3(0, 1550, 0.01), new THREE.Vector3(0, 0, 0)); }
  function clearSelection() { if (selectionOutline) { scene.remove(selectionOutline); selectionOutline.geometry.dispose(); selectionOutline = undefined; } }
  function selectBuilding(id: string) {
    if (!sceneReady) return;
    const record = byId.get(id);
    if (!record) return;
    selected = record;
    ui.select(id);
    clearSelection();
    const points = record.footprint.map(([x, z]) => new THREE.Vector3(x, 0.3, z));
    selectionOutline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), outlineMaterial);
    selectionOutline.renderOrder = 10;
    scene.add(selectionOutline);
    const size = Math.max(record.width, record.depth, record.height * 1.2, 16);
    const mobileFactor = Math.max(1, 0.85 / camera.aspect);
    const offset = new THREE.Vector3(size * 0.5, size * 0.65 + record.height * 0.3, size * 1.7).multiplyScalar(mobileFactor).applyAxisAngle(new THREE.Vector3(0, 1, 0), record.angle);
    const target = new THREE.Vector3(record.center[0], record.height * 0.4, record.center[1]);
    fly(target.clone().add(offset), target);
    visited.set(id, performance.now());
  }
  function startWalk() {
    if (!sceneReady) return;
    tween = undefined;
    const start = findWalkable(selected ? new THREE.Vector3(selected.center[0], 1.72, selected.center[1] + selected.depth / 2 + 8) : new THREE.Vector3(0, 1.72, bounds.maxZ - 115));
    camera.position.copy(start);
    camera.position.y = terrainHeight(start.x, start.z) + 1.72;
    const look = selected ? new THREE.Vector3(selected.center[0], 4, selected.center[1]) : new THREE.Vector3(0, 2, -100);
    yaw = Math.atan2(-(look.x - start.x), -(look.z - start.z)); pitch = 0.04;
    walking = true; controls.enabled = false; keys.clear(); ui.walking(true);
    renderer.domElement.requestPointerLock()?.catch(() => { /* Drag-to-look remains available. */ });
    updateLOD(true);
  }
  function stopWalk() {
    if (!walking) return;
    walking = false; keys.clear(); controls.enabled = true;
    document.exitPointerLock?.();
    const direction = new THREE.Vector3(); camera.getWorldDirection(direction);
    controls.target.copy(camera.position).addScaledVector(direction, 30);
    ui.walking(false);
  }
  function isBlocked(x: number, z: number) {
    let inWumenCourt = false;
    if (wumen) {
      const dx = x - wumen.center[0], dz = z - wumen.center[1];
      const c = Math.cos(wumen.angle), s = Math.sin(wumen.angle);
      const localX = dx * c - dz * s, localZ = dx * s + dz * c;
      inWumenCourt = Math.abs(localX) < wumen.width * 0.33
        && localZ > -wumen.depth * 0.08 && localZ < wumen.depth * 0.43;
    }
    if (!pointInPolygon(x, z, data.boundary) && !inWumenCourt) return true;
    const inWater = (data.waterAreas ?? []).some((area) => pointInPolygon(x, z, area.outer) && !area.holes.some((hole) => pointInPolygon(x, z, hole)));
    if (inWater && !data.paths.some((path) => path.some((p, i) => i > 0 && segmentDistance(x, z, path[i - 1], p) < 2.1))) return true;
    for (const b of data.buildings) {
      if (Math.abs(x - b.center[0]) > Math.max(b.width, b.depth) + 1 || Math.abs(z - b.center[1]) > Math.max(b.width, b.depth) + 1) continue;
      const dx = x - b.center[0], dz = z - b.center[1];
      const localX = dx * Math.cos(b.angle) - dz * Math.sin(b.angle);
      const localZ = dx * Math.sin(b.angle) + dz * Math.cos(b.angle);
      if (b === wumen) { if (wumenBlocks(b, localX, localZ)) return true; continue; }
      if (b.kind === 'gate' && Math.abs(localX) < Math.max(2.4, Math.min(5.4, b.width * 0.075))) continue;
      if (b.kind === 'wall' || irregularCourtyardIds.has(b.id)) { if (pointInPolygon(x, z, b.footprint)) return true; }
      else if (b.kind !== 'platform' && Math.abs(localX) < b.width / 2 + 0.4 && Math.abs(localZ) < b.depth / 2 + 0.4) return true;
    }
    return false;
  }
  function terrainHeight(x: number, z: number) {
    let y = 0;
    for (const { b, c, s, southZ, stairLength } of platformTerrain) {
      if (pointInPolygon(x, z, b.footprint)) { y = Math.max(y, b.height); continue; }
      const dx = x - b.center[0], dz = z - b.center[1];
      const localX = dx * c - dz * s;
      const localZ = dx * s + dz * c;
      if (Math.abs(localX) < 4 && localZ >= southZ && localZ <= southZ + stairLength) y = Math.max(y, b.height * (1 - (localZ - southZ) / stairLength));
    }
    return y;
  }
  function findWalkable(start: THREE.Vector3) {
    if (!isBlocked(start.x, start.z)) return start;
    for (let r = 3; r < 170; r += 3) for (let i = 0; i < 24; i++) {
      const x = start.x + Math.cos(i * Math.PI / 12) * r, z = start.z + Math.sin(i * Math.PI / 12) * r;
      if (!isBlocked(x, z)) return new THREE.Vector3(x, 1.72, z);
    }
    return new THREE.Vector3(0, 1.72, 150);
  }

  function updateLOD(force = false) {
    if (!sceneReady && !force) return;
    const mobile = container.clientWidth < 700;
    const midDistance = quality === 'high' ? 290 : quality === 'low' ? 105 : mobile ? 155 : 230;
    const highDistance = quality === 'high' ? 210 : quality === 'low' ? 0 : mobile ? 100 : 165;
    const candidates = data.buildings.filter((b) => b.kind !== 'wall').map((b) => ({ b, d: Math.hypot(camera.position.x - b.center[0], camera.position.z - b.center[1], Math.max(0, camera.position.y - b.height)) })).filter((entry) => entry.d < midDistance || entry.b.id === selected?.id).sort((a, b) => Number(b.b.id === selected?.id) - Number(a.b.id === selected?.id) || a.d - b.d).slice(0, quality === 'high' ? 32 : quality === 'low' ? 8 : 20);
    const wanted = new Set<string>();
    for (let i = 0; i < candidates.length; i++) {
      const { b, d } = candidates[i]; wanted.add(b.id);
      let cached = detailCache.get(b.id);
      if (!cached) { cached = { mid: buildArchitecture(b, 1), used: performance.now() }; detailCache.set(b.id, cached); scene.add(cached.mid); }
      cached.used = performance.now(); cached.mid.visible = true;
      const high = d < highDistance && i < (quality === 'high' ? 14 : 8);
      if (high && !cached.high) { cached.high = buildArchitecture(b, 2); scene.add(cached.high); }
      if (cached.high) cached.high.visible = high;
    }
    for (const id of activeDetail) if (!wanted.has(id)) { const cached = detailCache.get(id)!; cached.mid.visible = false; if (cached.high) cached.high.visible = false; }
    activeDetail.clear(); wanted.forEach((id) => activeDetail.add(id));
    if (detailCache.size > 64) {
      const stale = [...detailCache].filter(([id]) => !wanted.has(id)).sort((a, b) => a[1].used - b[1].used);
      for (const [id, c] of stale.slice(0, detailCache.size - 48)) { scene.remove(c.mid); disposeArchitecture(c.mid); if (c.high) { scene.remove(c.high); disposeArchitecture(c.high); } detailCache.delete(id); }
    }
  }
  function updateLabels() {
    if (!labelVisible || walking) { labelLayer.hidden = true; return; }
    labelLayer.hidden = false;
    const occupied: number[][] = [], w = container.clientWidth, h = container.clientHeight;
    for (const { record, element } of [...landmarkLabels].sort((a, b) => (b.record.id === selected?.id ? 1 : 0) - (a.record.id === selected?.id ? 1 : 0))) {
      v.set(record.center[0], record.height + 4, record.center[1]).project(camera);
      const x = (v.x + 1) * w / 2, y = (1 - v.y) * h / 2, ew = Math.max(65, record.name.length * 12 + 18);
      const hide = v.z > 1 || v.z < -1 || x < ew / 2 + 5 || x > w - ew / 2 - 5 || y < 100 || y > h - 95 || occupied.some(([ox, oy, ow]) => Math.abs(ox - x) < (ow + ew) / 2 + 4 && Math.abs(oy - y) < 32);
      element.hidden = hide;
      if (!hide) { element.style.left = `${x}px`; element.style.top = `${y}px`; occupied.push([x, y, ew]); }
    }
  }

  function addPaths() {
    const parts: THREE.BufferGeometry[] = [];
    for (const path of data.paths) for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 0.1) continue;
      const g = new THREE.BoxGeometry(3.5, 0.08, length);
      g.rotateY(Math.atan2(b[0] - a[0], b[1] - a[1]));
      g.translate((a[0] + b[0]) / 2, 0.02, (a[1] + b[1]) / 2); parts.push(g);
    }
    if (parts.length) { const g = mergeGeometries(parts)!; parts.forEach((p) => p.dispose()); const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xb8ad96, roughness: 1 })); mesh.receiveShadow = true; scene.add(mesh); }
  }
  function addGardens() {
    const trees: THREE.Matrix4[] = [], trunks: THREE.Matrix4[] = [];
    const rng = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
    const placeTree = (x: number, z: number, index: number) => {
      const h = 5 + rng(index + 5) * 7;
      trees.push(new THREE.Matrix4().compose(new THREE.Vector3(x, h * 0.65, z), new THREE.Quaternion(), new THREE.Vector3(h * 0.32, h * 0.53, h * 0.32)));
      trunks.push(new THREE.Matrix4().compose(new THREE.Vector3(x, h * 0.28, z), new THREE.Quaternion(), new THREE.Vector3(0.32, h * 0.6, 0.32)));
    };
    for (let i = 0; i < 125; i++) {
      const x = -104 + rng(i + 100) * 208, z = bounds.minZ + 50 + rng(i + 300) * 113;
      if (data.buildings.some((b) => pointInPolygon(x, z, b.footprint))) continue;
      placeTree(x, z, i);
    }
    for (let i = 0; i < 70; i++) {
      const side = i % 2 ? -1 : 1, x = side * (Math.max(Math.abs(bounds.maxX), Math.abs(bounds.minX)) + 78 + rng(i + 9) * 100), z = bounds.minZ + rng(i + 1200) * (bounds.maxZ - bounds.minZ);
      placeTree(x, z, i + 140);
    }
    const leaves = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x3e6450, roughness: 1, flatShading: true }), trees.length);
    trees.forEach((m, i) => leaves.setMatrixAt(i, m)); leaves.computeBoundingSphere(); scene.add(leaves);
    const wood = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 5), new THREE.MeshStandardMaterial({ color: 0x67533d, roughness: 1 }), trunks.length);
    trunks.forEach((m, i) => wood.setMatrixAt(i, m)); wood.computeBoundingSphere(); scene.add(wood);
  }
  function addPerimeter() {
    const pieces: THREE.Matrix4[] = [], teeth: THREE.Matrix4[] = [];
    const gates = data.buildings.filter((b) => b.kind === 'gate' && /午门|神武门|东华门|西华门/.test(b.name));
    for (let i = 0; i < data.boundary.length; i++) {
      const a = data.boundary[i], b = data.boundary[(i + 1) % data.boundary.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 0.2) continue;
      const count = Math.ceil(len / 4), theta = Math.atan2(b[0] - a[0], b[1] - a[1]);
      const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), theta);
      for (let j = 0; j < count; j++) {
        const x = a[0] + (b[0] - a[0]) * (j + 0.5) / count, z = a[1] + (b[1] - a[1]) * (j + 0.5) / count;
        if (gates.some((g) => Math.hypot(x - g.center[0], z - g.center[1]) < Math.max(18, g.width * 0.48))) continue;
        pieces.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 4.6, z), rotation, new THREE.Vector3(7, 9.2, len / count + 0.03)));
        teeth.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 9.65, z), rotation, new THREE.Vector3(7.4, 0.9, 2.5)));
      }
    }
    const wall = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x933b2a, roughness: 1 }), pieces.length);
    pieces.forEach((m, i) => wall.setMatrixAt(i, m)); wall.computeBoundingSphere(); scene.add(wall);
    const parapet = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x9f8f79, roughness: 1 }), teeth.length);
    teeth.forEach((m, i) => parapet.setMatrixAt(i, m)); parapet.computeBoundingSphere(); scene.add(parapet);
  }

  let last = performance.now(), statsAt = last, lodAt = last, frames = 0, fps = 0;
  sceneReady = true;
  camera.position.copy(fittedHome()); controls.update();
  updateLOD(true);
  ui.loading(1, '故宫建筑群已就绪');
  const debug = {
    data, renderedIds, get selected() { return selected?.id ?? null; }, get walking() { return walking; },
    select: selectBuilding, overview, top: topView, quality: (value: Quality) => { quality = value; setPixelRatio(); updateLOD(true); },
    get camera() { return camera.position.toArray(); }, get target() { return controls.target.toArray(); },
    get stats() { return { fps, draws: renderer.info.render.calls, triangles: renderer.info.render.triangles, detailBuildings: activeDetail.size }; },
    isBlocked, terrainHeight, findWalkable: (x: number, z: number) => findWalkable(new THREE.Vector3(x, 1.72, z)).toArray(),
    screenPoint: (id: string) => { const b = byId.get(id)!; const p = new THREE.Vector3(b.center[0], b.height * 0.7, b.center[1]).project(camera); const r = renderer.domElement.getBoundingClientRect(); return [r.left + (p.x + 1) * r.width / 2, r.top + (1 - p.y) * r.height / 2]; },
    rotate: (radians: number) => { const offset = camera.position.clone().sub(controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), radians); camera.position.copy(controls.target).add(offset); controls.update(); },
    startWalk, stopWalk, roofNames, ready: true,
  };
  (window as unknown as { __palace: typeof debug }).__palace = debug;
  function animate(now: number) {
    requestAnimationFrame(animate);
    const dt = Math.min((now - last) / 1000, 0.08); last = now; frames++;
    if (tween) {
      const t = clamp((now - tween.start) / 1400, 0, 1), smooth = t * t * (3 - 2 * t);
      camera.position.lerpVectors(tween.from, tween.to, smooth);
      controls.target.lerpVectors(tween.targetFrom, tween.targetTo, smooth);
      if (t === 1) tween = undefined;
    }
    if (walking) {
      camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
      const forward = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'));
      const right = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
      const speed = (keys.has('ShiftLeft') ? 12 : 5) * dt;
      const length = Math.hypot(forward, right) || 1;
      const dx = (-Math.sin(yaw) * forward + Math.cos(yaw) * right) * speed / length;
      const dz = (-Math.cos(yaw) * forward - Math.sin(yaw) * right) * speed / length;
      const currentHeight = terrainHeight(camera.position.x, camera.position.z);
      if (!isBlocked(camera.position.x + dx, camera.position.z) && Math.abs(terrainHeight(camera.position.x + dx, camera.position.z) - currentHeight) < 0.65) camera.position.x += dx;
      if (!isBlocked(camera.position.x, camera.position.z + dz) && Math.abs(terrainHeight(camera.position.x, camera.position.z + dz) - currentHeight) < 0.65) camera.position.z += dz;
      camera.position.y = terrainHeight(camera.position.x, camera.position.z) + 1.72;
    } else controls.update();
    if (now - lodAt > 500) { updateLOD(); lodAt = now; }
    updateLabels();
    renderer.render(scene, camera);
    if (now - statsAt > 1000) { fps = Math.round(frames * 1000 / (now - statsAt)); ui.stats(fps, renderer.info.render.calls, renderer.info.render.triangles); statsAt = now; frames = 0; }
  }
  requestAnimationFrame(animate);
}

boot().catch((error) => {
  console.error(error);
  const host = document.getElementById('app')!;
  const text = document.createElement('div');
  text.style.cssText = 'padding:3rem;font-family:serif;color:#7b3028;background:#f7f1e5;position:fixed;inset:0;z-index:100';
  text.textContent = `故宫模型暂未载入：${error instanceof Error ? error.message : '未知错误'}。请刷新页面重试。`;
  host.append(text);
});
