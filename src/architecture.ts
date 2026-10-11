import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { BuildingRecord, RoofKind } from './types';

/** All surface materials are shared. Geometry belongs to the returned building group. */
export const architectureMaterials: Record<string, THREE.Material> = {
  vermilion: new THREE.MeshStandardMaterial({ color: 0xa42e20, roughness: 0.82 }),
  shadowRed: new THREE.MeshStandardMaterial({ color: 0x68241d, roughness: 0.88 }),
  stone: new THREE.MeshStandardMaterial({ color: 0xd4c9ad, roughness: 0.92 }),
  brightStone: new THREE.MeshStandardMaterial({ color: 0xe7dec7, roughness: 0.9 }),
  timber: new THREE.MeshStandardMaterial({ color: 0x392421, roughness: 0.84 }),
  beam: new THREE.MeshStandardMaterial({ color: 0x79502a, roughness: 0.8 }),
  turquoise: new THREE.MeshStandardMaterial({ color: 0x367b76, roughness: 0.74 }),
  gilding: new THREE.MeshStandardMaterial({ color: 0xb99247, metalness: 0.28, roughness: 0.52 }),
  roofRidge: new THREE.MeshStandardMaterial({ color: 0x947037, metalness: 0.16, roughness: 0.69 }),
  darkRoof: new THREE.MeshStandardMaterial({ color: 0x474c45, roughness: 0.86, side: THREE.DoubleSide }),
};

type DetailLevel = 0 | 1 | 2;
type BoxPart = [number, number, number, number, number, number];

interface Span {
  x: number;
  z: number;
  w: number;
  d: number;
  eave: number;
  roofH: number;
  roofKind: RoofKind;
  yaw?: number;
  portals?: number;
  elevated?: boolean;
  bodyBase?: number;
  luding?: boolean;
}

const up = new THREE.Vector3(0, 1, 0);
const xAxis = new THREE.Vector3(1, 0, 0);
const roofMatCache = new Map<string, THREE.MeshStandardMaterial>();
let roofPattern: THREE.DataTexture | undefined;

function markOwned<T extends THREE.BufferGeometry>(geometry: T): T {
  geometry.userData.architectureOwned = true;
  return geometry;
}

function boxPart(x: number, y: number, z: number, w: number, h: number, d: number): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(Math.max(0.02, w), Math.max(0.02, h), Math.max(0.02, d));
  geometry.translate(x, y, z);
  return geometry;
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!parts.length) return null;
  if (parts.length === 1) return markOwned(parts[0]);
  const geometry = mergeGeometries(parts, false);
  parts.forEach((part) => part.dispose());
  return geometry ? markOwned(geometry) : null;
}

function addParts(group: THREE.Group, parts: BoxPart[], material: THREE.Material, name: string): void {
  const geometry = merged(parts.map(([x, y, z, w, h, d]) => boxPart(x, y, z, w, h, d)));
  if (!geometry) return;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

function patternTexture(): THREE.DataTexture {
  if (roofPattern) return roofPattern;
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const seam = x === 0 || x === size - 1 || y === size - 1;
      const crest = Math.cos((x / (size - 1) - 0.5) * Math.PI);
      const value = seam ? 116 : Math.round(190 + 35 * crest - 13 * (y / size));
      const offset = (y * size + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  roofPattern = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  roofPattern.wrapS = THREE.RepeatWrapping;
  roofPattern.wrapT = THREE.RepeatWrapping;
  roofPattern.magFilter = THREE.LinearFilter;
  roofPattern.minFilter = THREE.LinearMipmapLinearFilter;
  roofPattern.generateMipmaps = true;
  roofPattern.colorSpace = THREE.SRGBColorSpace;
  roofPattern.needsUpdate = true;
  return roofPattern;
}

function roofColor(color: string): string {
  const value = color.trim().toLowerCase();
  if (/green|绿|青|verdigris|turquoise/.test(value)) return '#477f65';
  if (/grey|gray|black|灰|黑|dark/.test(value)) return '#69706a';
  if (/yellow|gold|黄|金/.test(value)) return '#e2ad42';
  try {
    return `#${new THREE.Color(color).getHexString()}`;
  } catch {
    return '#e2ad42';
  }
}

function materialForRoof(color: string): THREE.MeshStandardMaterial {
  const key = roofColor(color);
  const cached = roofMatCache.get(key);
  if (cached) return cached;
  const material = new THREE.MeshStandardMaterial({
    color: key,
    map: patternTexture(),
    roughness: 0.72,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  roofMatCache.set(key, material);
  architectureMaterials[`roof:${key}`] = material;
  return material;
}

function isWumen(record: BuildingRecord): boolean {
  return /午门|wumen|meridian gate/i.test(`${record.id} ${record.name} ${record.landmark ?? ''}`);
}

function isCornerTower(record: BuildingRecord): boolean {
  return record.landmark === 'corner' || record.kind === 'tower'
    || /角楼|corner tower/i.test(`${record.id} ${record.name} ${record.landmark ?? ''}`);
}

function isTaihe(record: BuildingRecord): boolean {
  return record.landmark === 'taihe' || /太和殿|hall of supreme harmony/i.test(`${record.id} ${record.name}`);
}

function isQinan(record: BuildingRecord): boolean {
  return /钦安殿|qinan/i.test(`${record.id} ${record.name}`);
}

function isPlatform(record: BuildingRecord): boolean {
  return record.kind === 'platform';
}

function isMajorHall(record: BuildingRecord): boolean {
  return /太和殿|乾清宫|中和殿|保和殿|交泰殿|坤宁宫|hall of supreme harmony|palace of heavenly purity/i.test(
    `${record.id} ${record.name} ${record.landmark ?? ''}`,
  );
}

function baseHeight(record: BuildingRecord): number {
  if (record.kind === 'wall' || record.kind === 'gate') return 0;
  if (isTaihe(record)) return Math.min(8.13, record.height * 0.34);
  const ratio = isMajorHall(record) ? 0.10 : 0.055;
  return Math.min(isMajorHall(record) ? 3.2 : 1.6, Math.max(0.16, record.height * ratio));
}

function footprintArea(record: BuildingRecord): number {
  const points = record.footprint;
  if (points.length < 3) return 0;
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    twiceArea += points[i][0] * next[1] - next[0] * points[i][1];
  }
  return Math.abs(twiceArea) * 0.5;
}

function isIrregularCourtyard(record: BuildingRecord): boolean {
  return record.kind === 'building' && record.width * record.depth > 200
    && record.footprint.length >= 6 && footprintArea(record) / (record.width * record.depth) < 0.45;
}

/** Extrude the mapped polygon in the same local frame as its building record. */
function footprintPrism(record: BuildingRecord, bottom: number, height: number, expansion = 0): THREE.BufferGeometry | null {
  if (record.footprint.length < 3 || footprintArea(record) < 0.1) return null;
  const c = Math.cos(record.angle);
  const s = Math.sin(record.angle);
  const points: THREE.Vector2[] = [];
  for (const [worldX, worldZ] of record.footprint) {
    const dx = worldX - record.center[0];
    const dz = worldZ - record.center[1];
    const radius = Math.hypot(dx, dz);
    const scale = radius > 1e-6 ? (radius + expansion) / radius : 1;
    const x = dx * scale * c - dz * scale * s;
    const z = dx * scale * s + dz * scale * c;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const current = new THREE.Vector2(x, -z);
    if (!points.length || points[points.length - 1].distanceToSquared(current) > 1e-6) points.push(current);
  }
  if (points.length > 3 && points[0].distanceToSquared(points[points.length - 1]) < 1e-6) points.pop();
  if (points.length < 3) return null;
  const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(points), {
    depth: Math.max(0.02, height), steps: 1, bevelEnabled: false, curveSegments: 1,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, bottom, 0);
  if (!geometry.getAttribute('position').count) {
    geometry.dispose();
    return null;
  }
  return markOwned(geometry);
}

function addFootprintShell(record: BuildingRecord, group: THREE.Group): void {
  const isWall = record.kind === 'wall';
  const bodyTop = isWall ? record.height : record.height - Math.min(record.roofHeight * 0.3, 1.7);
  const wall = footprintPrism(record, 0, bodyTop);
  if (!wall) {
    addParts(group, [[0, bodyTop / 2, 0, record.width, bodyTop, record.depth]],
      architectureMaterials.vermilion, 'masonry fallback');
  } else {
    const body = new THREE.Mesh(wall, architectureMaterials.vermilion);
    body.name = isWall ? 'mapped wall footprint' : 'mapped courtyard wings';
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
  }
  const capDepth = isWall ? 0.34 : Math.max(0.12, record.height - bodyTop);
  const capBottom = isWall ? record.height - 0.17 : bodyTop;
  const cap = footprintPrism(record, capBottom, capDepth);
  if (cap) {
    const mesh = new THREE.Mesh(cap, isWall ? architectureMaterials.brightStone : materialForRoof(record.roofColor));
    mesh.name = isWall ? 'mapped wall coping' : 'mapped courtyard roof';
    mesh.castShadow = !isWall;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

function addPlatform(record: BuildingRecord, group: THREE.Group): void {
  const tierHeight = Math.max(0.15, record.height) / 3;
  const tiers = [
    footprintPrism(record, 0, tierHeight, 1),
    footprintPrism(record, tierHeight, tierHeight, 0.5),
    footprintPrism(record, tierHeight * 2, tierHeight),
  ];
  const platform = merged(tiers.filter((tier): tier is THREE.BufferGeometry => tier !== null));
  if (platform) {
    const mesh = new THREE.Mesh(platform, architectureMaterials.stone);
    mesh.name = 'mapped three-tier stone platform';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

function addPlatformDetails(record: BuildingRecord, group: THREE.Group): void {
  const points: THREE.Vector2[] = [];
  const c = Math.cos(record.angle), s = Math.sin(record.angle);
  for (const [worldX, worldZ] of record.footprint) {
    const dx = worldX - record.center[0], dz = worldZ - record.center[1];
    const point = new THREE.Vector2(dx * c - dz * s, dx * s + dz * c);
    if (!points.length || points[points.length - 1].distanceToSquared(point) > 1e-6) points.push(point);
  }
  if (points.length > 3 && points[0].distanceToSquared(points[points.length - 1]) < 1e-6) points.pop();
  if (points.length < 3) return;
  const axisCrossings: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if ((a.x <= 0 && b.x >= 0) || (a.x >= 0 && b.x <= 0)) {
      const t = -a.x / (b.x - a.x);
      if (Number.isFinite(t) && t >= 0 && t <= 1) axisCrossings.push(a.y + (b.y - a.y) * t);
    }
  }
  // The source terraces are often U-shaped. Attach the stair to the actual
  // southern edge on the central axis, not to a wing's farthest corner.
  const southZ = axisCrossings.length ? Math.max(...axisCrossings) : Math.max(...points.map((point) => point.y));
  const gapHalfWidth = 4.15;
  const postH = Math.max(0.58, Math.min(0.95, record.height * 0.22));
  const posts: THREE.Matrix4[] = [];
  const railParts: THREE.BufferGeometry[] = [];
  const isStairOpening = (x: number, z: number): boolean =>
    z > southZ - Math.max(2, record.depth * 0.07) && Math.abs(x) < gapHalfWidth;
  for (let edge = 0; edge < points.length && posts.length < 650; edge++) {
    const a = points[edge], b = points[(edge + 1) % points.length];
    const dx = b.x - a.x, dz = b.y - a.y;
    const length = Math.hypot(dx, dz);
    if (length < 0.4) continue;
    const count = Math.max(1, Math.min(650 - posts.length, Math.ceil(length / 2.3)));
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const x = a.x + dx * t, z = a.y + dz * t;
      if (isStairOpening(x, z)) continue;
      posts.push(matrixAt(x, record.height + postH / 2, z, 0.21, postH, 0.21));
    }
    const stepLength = length / count;
    const rotation = -Math.atan2(dz, dx);
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const x = a.x + dx * t, z = a.y + dz * t;
      if (isStairOpening(x, z)) continue;
      const rail = boxPart(0, record.height + postH * 0.78, 0, stepLength * 0.94, 0.14, 0.16);
      rail.rotateY(rotation);
      rail.translate(x, 0, z);
      railParts.push(rail);
    }
  }
  addInstances(group, new THREE.BoxGeometry(1, 1, 1), architectureMaterials.brightStone,
    posts, 'platform marble railing posts', false);
  const rails = merged(railParts);
  if (rails) {
    const mesh = new THREE.Mesh(rails, architectureMaterials.brightStone);
    mesh.name = 'platform marble railing';
    mesh.castShadow = false;
    group.add(mesh);
  }
  const stepCount = Math.max(6, Math.min(26, Math.ceil(record.height * 2.6)));
  const rampLength = Math.max(1.8, record.height * 1.8);
  const tread = rampLength / stepCount;
  const stairs: BoxPart[] = [];
  for (let i = 0; i < stepCount; i++) {
    const stepHeight = record.height * (stepCount - i) / (stepCount + 1);
    stairs.push([0, stepHeight / 2, southZ + (i + 0.5) * tread, 8, stepHeight, tread * 1.01]);
  }
  addParts(group, stairs, architectureMaterials.brightStone, 'south marble stair flight');
}

function spansFor(record: BuildingRecord): Span[] {
  const w = Math.max(2, record.width);
  const d = Math.max(2, record.depth);
  const h = Math.max(2, record.height);
  const roofH = Math.max(0.6, Math.min(record.roofHeight, h * 0.62));
  const eave = Math.max(baseHeight(record) + 0.8, h - roofH);
  if (record.kind === 'wall') {
    return [{ x: 0, z: 0, w, d, eave: h, roofH: 0, roofKind: 'flat' }];
  }
  if (isQinan(record)) {
    return [
      { x: 0, z: 0, w, d, eave, roofH: roofH * 0.44, roofKind: 'flat', luding: true },
      { x: 0, z: 0, w: w * 0.74, d: d * 0.78, eave: h - roofH * 0.55,
        roofH: roofH * 0.55, roofKind: 'flat', luding: true, elevated: true },
    ];
  }
  if (isWumen(record)) {
    const mainEave = Math.min(eave, h * 0.62);
    const wingEave = mainEave * 0.72;
    const turretEave = h - roofH * 0.27;
    const turretRoof = h - turretEave;
    const mainTop = mainEave + roofH * 0.72;
    const wingTop = wingEave + roofH * 0.53;
    return [
      { x: 0, z: -d * 0.29, w, d: d * 0.43, eave: mainEave, roofH: roofH * 0.72, roofKind: 'hipped', portals: 5 },
      { x: -w * 0.405, z: d * 0.07, w: w * 0.16, d: d * 0.78, eave: wingEave, roofH: roofH * 0.53, roofKind: 'half-hipped', yaw: Math.PI / 2 },
      { x: w * 0.405, z: d * 0.07, w: w * 0.16, d: d * 0.78, eave: wingEave, roofH: roofH * 0.53, roofKind: 'half-hipped', yaw: Math.PI / 2 },
      { x: 0, z: -d * 0.29, w: w * 0.20, d: d * 0.19, eave: turretEave, roofH: turretRoof, roofKind: 'hipped', elevated: true, bodyBase: mainTop - 0.4 },
      { x: -w * 0.27, z: -d * 0.29, w: w * 0.13, d: d * 0.14, eave: turretEave, roofH: turretRoof, roofKind: 'pyramidal', elevated: true, bodyBase: mainTop - 0.4 },
      { x: w * 0.27, z: -d * 0.29, w: w * 0.13, d: d * 0.14, eave: turretEave, roofH: turretRoof, roofKind: 'pyramidal', elevated: true, bodyBase: mainTop - 0.4 },
      { x: -w * 0.405, z: d * 0.38, w: w * 0.145, d: d * 0.17, eave: turretEave, roofH: turretRoof, roofKind: 'pyramidal', elevated: true, bodyBase: wingTop - 0.35 },
      { x: w * 0.405, z: d * 0.38, w: w * 0.145, d: d * 0.17, eave: turretEave, roofH: turretRoof, roofKind: 'pyramidal', elevated: true, bodyBase: wingTop - 0.35 },
    ];
  }
  if (isCornerTower(record)) {
    const lowerEave = Math.max(baseHeight(record) + 0.8, h * 0.52);
    const middleEave = h * 0.72;
    const upperEave = h - roofH * 0.36;
    const lowerRoofH = Math.min(roofH * 0.42, (middleEave - lowerEave) * 0.75);
    const middleRoofH = Math.min(roofH * 0.38, (upperEave - middleEave) * 0.75);
    return [
      { x: 0, z: 0, w, d, eave: lowerEave, roofH: lowerRoofH, roofKind: 'hipped' },
      { x: 0, z: 0, w: w * 0.70, d: d * 0.70, eave: middleEave, roofH: middleRoofH,
        roofKind: 'hipped', elevated: true, bodyBase: lowerEave + lowerRoofH - 0.4 },
      { x: 0, z: 0, w: w * 0.43, d: d * 0.43, eave: upperEave, roofH: h - upperEave,
        roofKind: 'hipped', elevated: true, bodyBase: middleEave + middleRoofH - 0.4 },
    ];
  }
  if (record.doubleRoof) {
    return [
      { x: 0, z: 0, w, d, eave, roofH: roofH * 0.43, roofKind: record.roofKind },
      { x: 0, z: 0, w: w * 0.73, d: d * 0.73, eave: h - roofH * 0.55, roofH: roofH * 0.55, roofKind: record.roofKind, elevated: true },
    ];
  }
  return [{ x: 0, z: 0, w, d, eave, roofH, roofKind: record.roofKind, portals: record.kind === 'gate' ? 3 : undefined }];
}

function transformSpanGeometry(geometry: THREE.BufferGeometry, span: Span): THREE.BufferGeometry {
  if (span.yaw) geometry.rotateY(span.yaw);
  geometry.translate(span.x, 0, span.z);
  return geometry;
}

// The Meridian Gate's side galleries run north to south. Their roof geometry
// is built along its long local X axis, then turned to match the footprint.
function roofFrame(span: Span): Span {
  return span.yaw ? { ...span, w: span.d, d: span.w } : span;
}

function roofProfile(t: number, roofH: number): number {
  return roofH * Math.pow(t, 1.55);
}

function roofPoint(span: Span, t: number, x: number, sign: number): THREE.Vector3 {
  const overhang = Math.min(2.2, Math.max(0.45, Math.min(span.w, span.d) * 0.085));
  const halfX = span.w / 2 + overhang;
  const halfZ = span.d / 2 + overhang;
  const ridgeHalfX = span.luding ? halfX * 0.46 : span.roofKind === 'gabled' ? halfX
    : span.roofKind === 'half-hipped' ? Math.max(0, halfX - halfZ * 0.28)
      : span.roofKind === 'pyramidal' ? 0
        : Math.max(0, halfX - halfZ * 0.83);
  const extent = halfX + (ridgeHalfX - halfX) * t;
  const actualX = x * extent;
  const uplift = span.roofH * 0.065 * Math.pow(Math.abs(x), 6) * Math.pow(1 - t, 2);
  const innerZ = span.luding ? halfZ * 0.4 : 0;
  return new THREE.Vector3(actualX, span.eave + roofProfile(t, span.roofH) + uplift,
    sign * (halfZ + (innerZ - halfZ) * t));
}

function curvedRoofGeometry(span: Span): THREE.BufferGeometry {
  const frame = roofFrame(span);
  if (span.roofKind === 'flat' && !span.luding) {
    return transformSpanGeometry(boxPart(0, span.eave + 0.12, 0, span.w * 1.08, 0.24, span.d * 1.08), span);
  }
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const push = (point: THREE.Vector3, u: number, v: number): void => {
    positions.push(point.x, point.y, point.z);
    uvs.push(u, v);
  };
  if (span.roofKind === 'round') {
    const rings = 10;
    const segments = 24;
    const radius = Math.max(frame.w, frame.d) * 0.54;
    for (let r = 0; r <= rings; r++) {
      const t = r / rings;
      const ringR = Math.max(0.002, radius * (1 - t));
      for (let a = 0; a <= segments; a++) {
        const angle = a / segments * Math.PI * 2;
        const corner = span.roofH * 0.07 * Math.pow(1 - t, 2);
        push(new THREE.Vector3(Math.cos(angle) * ringR, span.eave + roofProfile(t, span.roofH) + corner, Math.sin(angle) * ringR),
          a / segments * radius * 4, t * radius * 2);
      }
    }
    for (let r = 0; r < rings; r++) for (let a = 0; a < segments; a++) {
      const i = r * (segments + 1) + a;
      indices.push(i, i + segments + 1, i + 1, i + 1, i + segments + 1, i + segments + 2);
    }
  } else {
    const rows = 9;
    const cols = 16;
    for (const sign of [-1, 1]) {
      const start = positions.length / 3;
      for (let r = 0; r <= rows; r++) {
        const t = r / rows;
        for (let c = 0; c <= cols; c++) {
          const x = -1 + 2 * c / cols;
          push(roofPoint(frame, t, x, sign), (x + 1) * frame.w / 1.45, t * frame.d / 1.45);
        }
      }
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const i = start + r * (cols + 1) + c;
        indices.push(i, i + cols + 1, i + 1, i + 1, i + cols + 1, i + cols + 2);
      }
    }
    // Hip and gable end surfaces close the outline instead of leaving triangular holes.
    for (const sign of [-1, 1]) {
      const start = positions.length / 3;
      for (let r = 0; r <= rows; r++) {
        const t = r / rows;
        const edge = roofPoint(frame, t, sign, 1);
        for (let c = 0; c <= cols; c++) {
          const u = -1 + 2 * c / cols;
          push(new THREE.Vector3(edge.x, edge.y, u * edge.z), (u + 1) * frame.d / 1.45, t * frame.w / 1.45);
        }
      }
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const i = start + r * (cols + 1) + c;
        indices.push(i, i + cols + 1, i + 1, i + 1, i + cols + 1, i + cols + 2);
      }
    }
    if (frame.luding) {
      const corners = [
        roofPoint(frame, 1, -1, -1), roofPoint(frame, 1, 1, -1),
        roofPoint(frame, 1, 1, 1), roofPoint(frame, 1, -1, 1),
      ];
      const start = positions.length / 3;
      for (const point of corners) push(point, point.x / 1.45, point.z / 1.45);
      indices.push(start, start + 2, start + 1, start, start + 3, start + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return transformSpanGeometry(geometry, span);
}

function bodyBoxes(span: Span, base: number): BoxPart[] {
  const top = span.eave;
  const bottom = span.bodyBase ?? (span.elevated ? Math.max(base, span.eave - span.roofH * 0.88) : base);
  const height = Math.max(0.3, top - bottom);
  const w = span.w * (span.elevated ? 0.86 : 0.91);
  const d = span.d * (span.elevated ? 0.86 : 0.91);
  if (!span.portals) return [[span.x, bottom + height / 2, span.z, w, height, d]];
  const parts: BoxPart[] = [];
  const count = span.portals;
  const pier = Math.max(0.55, Math.min(w * 0.085, w / (count * 3.2)));
  const openingW = (w - (count + 1) * pier) / count;
  const openH = height * 0.66;
  for (let i = 0; i <= count; i++) {
    const x = span.x - w / 2 + pier / 2 + i * (pier + openingW);
    parts.push([x, bottom + openH / 2, span.z, pier, openH, d]);
  }
  parts.push([span.x, bottom + openH + (height - openH) / 2, span.z, w, height - openH, d]);
  return parts;
}

function addLow(record: BuildingRecord, group: THREE.Group, spans: Span[]): void {
  const base = baseHeight(record);
  const stone: BoxPart[] = [];
  const walls: BoxPart[] = [];
  const darkPanels: BoxPart[] = [];
  const fascia: BoxPart[] = [];
  const roofs: THREE.BufferGeometry[] = [];
  if (base > 0 && record.kind !== 'wall') {
    if (isTaihe(record)) {
      for (let tier = 0; tier < 3; tier++) {
        const tierH = base / 3;
        stone.push([0, (tier + 0.5) * tierH, 0,
          record.width * (1.22 - tier * 0.075), tierH, record.depth * (1.24 - tier * 0.075)]);
      }
    } else {
      stone.push([0, base * 0.5, 0, record.width * 1.07, base, record.depth * 1.09]);
      if (isMajorHall(record)) {
        stone.push([0, base * 0.17, 0, record.width * 1.16, base * 0.32, record.depth * 1.18]);
      }
    }
  }
  for (const span of spans) {
    walls.push(...bodyBoxes(span, base));
    if (!span.portals && record.kind !== 'wall' && !span.elevated) {
      const doorW = Math.min(span.w * 0.32, Math.max(1.3, span.w * 0.23));
      const doorH = Math.max(0.6, (span.eave - base) * 0.58);
      darkPanels.push([span.x, base + doorH / 2, span.z + span.d * 0.456, doorW, doorH, 0.12]);
    }
    if (record.kind !== 'wall') roofs.push(curvedRoofGeometry(span));
    const lip = Math.max(0.12, Math.min(0.42, span.w * 0.012));
    if (record.kind !== 'wall') {
      const y = span.eave - 0.09;
      const ew = span.w * 1.09;
      const ed = span.d * 1.09;
      fascia.push([span.x, y, span.z - ed / 2, ew, lip, lip]);
      fascia.push([span.x, y, span.z + ed / 2, ew, lip, lip]);
      fascia.push([span.x - ew / 2, y, span.z, lip, lip, ed]);
      fascia.push([span.x + ew / 2, y, span.z, lip, lip, ed]);
    }
  }
  addParts(group, stone, architectureMaterials.stone, 'stone plinth');
  addParts(group, walls, architectureMaterials.vermilion, 'vermilion masonry');
  addParts(group, darkPanels, architectureMaterials.timber, 'main door');
  const roofGeometry = merged(roofs);
  if (roofGeometry) {
    const roof = new THREE.Mesh(roofGeometry, materialForRoof(record.roofColor));
    roof.name = 'curved glazed roof';
    roof.castShadow = true;
    roof.receiveShadow = true;
    group.add(roof);
  }
  addParts(group, fascia, architectureMaterials.roofRidge, 'roof eave outline');
  if (record.kind === 'wall') {
    addParts(group, [[0, record.height - 0.17, 0, record.width * 1.05, 0.34, record.depth * 1.12]],
      architectureMaterials.brightStone, 'wall coping');
  }
}

function addInstances(group: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material,
  matrices: THREE.Matrix4[], name: string, shadows = true): void {
  if (!matrices.length) {
    geometry.dispose();
    return;
  }
  const mesh = new THREE.InstancedMesh(markOwned(geometry), material, matrices.length);
  matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.name = name;
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  mesh.computeBoundingSphere();
  group.add(mesh);
}

function matrixAt(x: number, y: number, z: number, sx = 1, sy = 1, sz = 1,
  rotation = new THREE.Quaternion()): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), rotation, new THREE.Vector3(sx, sy, sz));
}

function addMid(record: BuildingRecord, group: THREE.Group, spans: Span[]): void {
  if (record.kind === 'wall') {
    const crenels: THREE.Matrix4[] = [];
    const c = Math.cos(record.angle), s = Math.sin(record.angle);
    for (let edge = 0; edge < record.footprint.length && crenels.length < 500; edge++) {
      const a = record.footprint[edge], b = record.footprint[(edge + 1) % record.footprint.length];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const length = Math.hypot(dx, dz);
      if (length < 3) continue;
      const count = Math.min(500 - crenels.length, Math.floor(length / 2.5));
      const rotation = new THREE.Quaternion().setFromAxisAngle(up, -Math.atan2(dz * c + dx * s, dx * c - dz * s));
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count;
        const worldX = a[0] + dx * t - record.center[0];
        const worldZ = a[1] + dz * t - record.center[1];
        const x = worldX * c - worldZ * s;
        const z = worldX * s + worldZ * c;
        crenels.push(matrixAt(x, record.height + 0.17, z, Math.min(1.4, length / count * 0.6), 0.35, 0.55, rotation));
      }
    }
    addInstances(group, new THREE.BoxGeometry(1, 1, 1), architectureMaterials.brightStone, crenels, 'wall merlons', false);
    return;
  }

  const columns: THREE.Matrix4[] = [];
  const whitePosts: THREE.Matrix4[] = [];
  const beams: BoxPart[] = [];
  const blueBrackets: BoxPart[] = [];
  const goldBrackets: BoxPart[] = [];
  const woodPanels: BoxPart[] = [];
  const goldMullions: BoxPart[] = [];
  const railings: BoxPart[] = [];
  const base = baseHeight(record);
  for (const span of spans) {
    if (span.elevated) continue;
    const columnCount = Math.max(2, Math.min(18, Math.round(span.w / 3.6)));
    const columnH = Math.max(0.8, span.eave - base - 0.24);
    const columnRadius = Math.min(0.4, Math.max(0.16, span.w / (columnCount * 18)));
    for (const sign of [-1, 1]) {
      const z = span.z + sign * span.d * 0.474;
      for (let i = 0; i < columnCount; i++) {
        const x = span.x - span.w * 0.46 + (i + 0.5) * span.w * 0.92 / columnCount;
        columns.push(matrixAt(x, base + columnH / 2, z, columnRadius, columnH, columnRadius));
        const bracketY = span.eave - 0.4;
        const b = Math.min(0.9, Math.max(0.3, span.w / columnCount * 0.19));
        blueBrackets.push([x, bracketY, z, b * 1.35, 0.22, b * 0.82]);
        blueBrackets.push([x, bracketY + 0.21, z, b * 0.9, 0.19, b * 1.26]);
        goldBrackets.push([x, bracketY + 0.39, z, b * 1.45, 0.14, b * 0.72]);
      }
      beams.push([span.x, span.eave - 0.68, z, span.w * 0.98, 0.28, 0.27]);
      blueBrackets.push([span.x, span.eave - 0.88, z, span.w * 0.94, 0.11, 0.42]);
    }
    if (!span.portals) {
      const count = Math.max(3, Math.min(13, Math.round(span.w / 4.8)));
      const pitch = span.w * 0.84 / count;
      const bayW = pitch * 0.80;
      const bayH = Math.max(0.7, (span.eave - base) * 0.59);
      for (const sign of [-1, 1]) {
        const z = span.z + sign * (span.d * 0.455 + 0.055);
        for (let i = 0; i < count; i++) {
          const x = span.x + (i - (count - 1) / 2) * pitch;
          woodPanels.push([x, base + bayH / 2, z, bayW, bayH, 0.09]);
          const trimZ = z + sign * 0.06;
          for (const fraction of [0.28, 0.53, 0.78]) {
            goldMullions.push([x, base + bayH * fraction, trimZ, bayW * 0.94, 0.055, 0.05]);
          }
          for (const fraction of [-0.25, 0, 0.25]) {
            goldMullions.push([x + bayW * fraction, base + bayH * 0.5, trimZ, 0.05, bayH * 0.93, 0.05]);
          }
        }
      }
      const sideCount = Math.max(1, Math.min(8, Math.round(span.d / 5.2)));
      const sidePitch = span.d * 0.72 / sideCount;
      const sideW = sidePitch * 0.72;
      for (const sign of [-1, 1]) {
        const x = span.x + sign * (span.w * 0.455 + 0.055);
        for (let i = 0; i < sideCount; i++) {
          const z = span.z + (i - (sideCount - 1) / 2) * sidePitch;
          woodPanels.push([x, base + bayH * 0.53, z, 0.09, bayH * 0.78, sideW]);
          goldMullions.push([x + sign * 0.06, base + bayH * 0.52, z, 0.05, 0.055, sideW * 0.92]);
          goldMullions.push([x + sign * 0.06, base + bayH * 0.29, z, 0.05, 0.055, sideW * 0.92]);
          goldMullions.push([x + sign * 0.06, base + bayH * 0.47, z, 0.05, bayH * 0.72, 0.05]);
        }
      }
    }
  }
  addInstances(group, new THREE.CylinderGeometry(1, 1.09, 1, 10), architectureMaterials.vermilion, columns, 'painted timber columns');
  addParts(group, beams, architectureMaterials.beam, 'painted beam');
  addParts(group, blueBrackets, architectureMaterials.turquoise, 'dougong bracket sets');
  addParts(group, goldBrackets, architectureMaterials.gilding, 'dougong gold layers');
  addParts(group, woodPanels, architectureMaterials.timber, 'lattice doors');
  addParts(group, goldMullions, architectureMaterials.gilding, 'door lattice');

  if (base > 0.2) {
    const w = record.width * 1.085;
    const d = record.depth * 1.105;
    const spacing = Math.max(1.1, Math.min(2.4, Math.min(w, d) / 12));
    const nX = Math.min(44, Math.max(2, Math.floor(w / spacing)));
    const nZ = Math.min(44, Math.max(2, Math.floor(d / spacing)));
    const postH = Math.min(1.05, Math.max(0.42, base * 0.54));
    for (let i = 0; i <= nX; i++) {
      const x = -w / 2 + i * w / nX;
      for (const sign of [-1, 1]) whitePosts.push(matrixAt(x, base + postH / 2, sign * d / 2, 0.18, postH, 0.18));
    }
    for (let i = 1; i < nZ; i++) {
      const z = -d / 2 + i * d / nZ;
      for (const sign of [-1, 1]) whitePosts.push(matrixAt(sign * w / 2, base + postH / 2, z, 0.18, postH, 0.18));
    }
    railings.push([0, base + postH * 0.77, -d / 2, w, 0.13, 0.16]);
    railings.push([0, base + postH * 0.77, d / 2, w, 0.13, 0.16]);
    railings.push([-w / 2, base + postH * 0.77, 0, 0.16, 0.13, d]);
    railings.push([w / 2, base + postH * 0.77, 0, 0.16, 0.13, d]);
    if (isMajorHall(record)) {
      for (let step = 0; step < 5; step++) {
        const stepH = base * (step + 1) / 5;
        railings.push([0, stepH / 2, d * 0.55 + step * base * 0.55, w * 0.32, stepH, base * 0.6]);
      }
    }
  }
  addInstances(group, new THREE.BoxGeometry(1, 1, 1), architectureMaterials.brightStone, whitePosts, 'marble balustrade posts', false);
  addParts(group, railings, architectureMaterials.brightStone, 'marble balustrades and steps');
}

function tileGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const across = 6;
  for (let z = 0; z <= 1; z++) {
    for (let i = 0; i <= across; i++) {
      const x = -0.5 + i / across;
      positions.push(x, 0.085 * Math.cos(x * Math.PI), z - 0.5);
      uvs.push(i / across, z);
    }
  }
  for (let i = 0; i < across; i++) {
    indices.push(i, i + 1, i + across + 1, i + 1, i + across + 2, i + across + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function addHigh(record: BuildingRecord, group: THREE.Group, spans: Span[]): void {
  if (record.kind === 'wall') return;
  const tiles: THREE.Matrix4[] = [];
  const finials: THREE.Matrix4[] = [];
  const ridgeParts: THREE.BufferGeometry[] = [];
  for (const span of spans) {
    if ((span.roofKind === 'flat' && !span.luding) || span.roofKind === 'round') continue;
    const frame = roofFrame(span);
    const overhang = Math.min(2.2, Math.max(0.45, Math.min(frame.w, frame.d) * 0.085));
    const halfDepth = frame.d / 2 + overhang;
    const slopeDepth = halfDepth * (frame.luding ? 0.6 : 1);
    const rows = Math.max(4, Math.min(28, Math.ceil(slopeDepth / 0.8)));
    for (const sign of [-1, 1]) {
      for (let row = 0; row < rows; row++) {
        const t = (row + 0.5) / rows;
        const extent = roofPoint(frame, t, 1, sign).x;
        const columns = Math.max(5, Math.min(88, Math.ceil(extent * 2 / 0.8)));
        const tileW = extent * 2 / columns;
        const slope = (roofProfile(Math.min(1, t + 0.015), span.roofH) - roofProfile(Math.max(0, t - 0.015), span.roofH)) / (0.03 * slopeDepth);
        const rotation = new THREE.Quaternion().setFromAxisAngle(xAxis, sign * Math.atan(slope));
        if (span.yaw) rotation.premultiply(new THREE.Quaternion().setFromAxisAngle(up, span.yaw));
        for (let col = 0; col < columns; col++) {
          const u = -1 + 2 * (col + 0.5) / columns;
          const point = roofPoint(frame, t, u, sign);
          if (span.yaw) point.applyAxisAngle(up, span.yaw);
          point.x += span.x;
          point.z += span.z;
          point.y += 0.04;
          tiles.push(matrixAt(point.x, point.y, point.z, tileW * 0.94, 1, slopeDepth / rows * 1.11, rotation));
        }
      }
    }
    if (frame.luding) {
      const topW = (frame.w / 2 + overhang) * 0.92;
      const topD = (frame.d / 2 + overhang) * 0.8;
      const y = span.eave + span.roofH + 0.06;
      for (const sign of [-1, 1]) {
        ridgeParts.push(transformSpanGeometry(boxPart(0, y, sign * topD / 2, topW, 0.16, 0.16), span));
        ridgeParts.push(transformSpanGeometry(boxPart(sign * topW / 2, y, 0, 0.16, 0.16, topD), span));
      }
      continue;
    }
    const ridgeLength = frame.roofKind === 'gabled' ? frame.w * 1.12 : Math.max(frame.w * 0.34, frame.w - frame.d * 0.72);
    ridgeParts.push(transformSpanGeometry(boxPart(0, span.eave + span.roofH + 0.1, 0, ridgeLength, 0.24, 0.31), span));
    for (const side of [-1, 1]) {
      const point = new THREE.Vector3(side * ridgeLength / 2, span.eave + span.roofH + 0.35, 0);
      if (span.yaw) point.applyAxisAngle(up, span.yaw);
      finials.push(matrixAt(span.x + point.x, point.y, span.z + point.z, 0.28, 0.55, 0.28));
    }
  }
  addInstances(group, tileGeometry(), materialForRoof(record.roofColor), tiles, 'individual glazed roof tiles', false);
  const ridgeGeometry = merged(ridgeParts);
  if (ridgeGeometry) {
    const ridge = new THREE.Mesh(ridgeGeometry, architectureMaterials.roofRidge);
    ridge.name = 'ornamented roof ridge';
    ridge.castShadow = true;
    group.add(ridge);
  }
  addInstances(group, new THREE.ConeGeometry(1, 1, 8), architectureMaterials.gilding, finials, 'ridge end ornaments', false);
}

/**
 * Build one additive LOD layer. Level 0 contains the entire distant silhouette;
 * levels 1 and 2 contain only details and may be toggled independently.
 */
export function buildArchitecture(record: BuildingRecord, level: DetailLevel): THREE.Group {
  const group = new THREE.Group();
  group.name = `${record.name} · L${level}`;
  group.userData.buildingId = record.id;
  group.userData.architectureLevel = level;
  group.position.set(record.center[0], 0, record.center[1]);
  group.rotation.y = record.angle;
  if (isPlatform(record)) {
    if (level === 0) addPlatform(record, group);
    else if (level === 1) addPlatformDetails(record, group);
    return group;
  }
  if (record.kind === 'wall' || isIrregularCourtyard(record)) {
    if (level === 0) addFootprintShell(record, group);
    else if (record.kind === 'wall' && level === 1) addMid(record, group, []);
    return group;
  }
  const spans = spansFor(record);
  if (level === 0) addLow(record, group, spans);
  else if (level === 1) addMid(record, group, spans);
  else addHigh(record, group, spans);
  return group;
}

/** Dispose geometry owned by one LOD layer while retaining globally shared materials. */
export function disposeArchitecture(group: THREE.Group): void {
  const disposed = new Set<THREE.BufferGeometry>();
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry;
    if (geometry.userData.architectureOwned && !disposed.has(geometry)) {
      geometry.dispose();
      disposed.add(geometry);
    }
  });
  group.clear();
}
