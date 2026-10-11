import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildArchitecture, disposeArchitecture } from '../src/architecture.ts';
import type { BuildingRecord, PalaceData } from '../src/types.ts';

const dataFile = new URL('../public/data/palace.json', import.meta.url);
const data: PalaceData | null = existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, 'utf8')) as PalaceData : null;
let checked = 0;

function record(partial: Partial<BuildingRecord>): BuildingRecord {
  return {
    id: 'geometry-fixture', name: '测试殿宇', zone: 'fixture',
    footprint: [[-20, -12], [20, -12], [20, 12], [-20, 12]],
    center: [0, 0], width: 40, depth: 24, angle: 0, height: 18,
    roofHeight: 6, roofKind: 'hipped', roofColor: 'yellow',
    kind: 'building', confidence: 'estimated', source: 'geometry fixture',
    ...partial,
  };
}

function meshes(group: THREE.Group): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  group.traverse((object) => { if (object instanceof THREE.Mesh) result.push(object); });
  return result;
}

function assertFinite(group: THREE.Group, label: string): void {
  for (const mesh of meshes(group)) {
    for (const attributeName of ['position', 'normal', 'uv']) {
      const attribute = mesh.geometry.getAttribute(attributeName);
      assert(attribute, `${label}: ${mesh.name} lacks ${attributeName}`);
      const array = attribute.array;
      for (let i = 0; i < array.length; i++) {
        assert(Number.isFinite(array[i]), `${label}: ${mesh.name} has nonfinite ${attributeName}[${i}]`);
      }
    }
    if (mesh instanceof THREE.InstancedMesh) {
      assert(mesh.count <= 20_000, `${label}: ${mesh.name} uses ${mesh.count} instances`);
      for (let i = 0; i < mesh.instanceMatrix.array.length; i++) {
        assert(Number.isFinite(mesh.instanceMatrix.array[i]), `${label}: invalid instance matrix`);
      }
    }
  }
}

function checkLayer(building: BuildingRecord, level: 0 | 1 | 2): THREE.Group {
  const layer = buildArchitecture(building, level);
  assert.equal(layer.position.x, building.center[0], `${building.name} center X`);
  assert.equal(layer.position.z, building.center[1], `${building.name} center Z`);
  assert.equal(layer.rotation.y, building.angle, `${building.name} orientation`);
  assert(meshes(layer).length <= 10, `${building.name} L${level}: excessive draw calls`);
  assertFinite(layer, `${building.name} L${level}`);
  checked++;
  return layer;
}

function checkTop(building: BuildingRecord, tolerance = 0.25): void {
  const low = checkLayer(building, 0);
  low.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(low);
  assert(Math.abs(box.max.y - building.height) <= tolerance,
    `${building.name}: top ${box.max.y.toFixed(3)} differs from ${building.height}`);
  assert(box.max.y > box.min.y, `${building.name}: empty building`);
  disposeArchitecture(low);
}

function rayThroughLocal(group: THREE.Group, x: number, y: number, z: number): THREE.Intersection[] {
  group.updateMatrixWorld(true);
  const origin = group.localToWorld(new THREE.Vector3(x, y, z));
  const direction = new THREE.Vector3(0, 0, -1).transformDirection(group.matrixWorld);
  const ray = new THREE.Raycaster(origin, direction, 0, 400);
  const redWalls = meshes(group).filter((mesh) => mesh.name === 'vermilion masonry');
  return ray.intersectObjects(redWalls, false);
}

function checkPortal(building: BuildingRecord): void {
  const low = checkLayer(building, 0);
  const y = Math.min(2.2, building.height * 0.16);
  const z = building.depth / 2 + 12;
  assert.equal(rayThroughLocal(low, 0, y, z).length, 0,
    `${building.name}: central gate portal is blocked`);
  assert(rayThroughLocal(low, -building.width * 0.43, y, z).length > 0,
    `${building.name}: gate pier is missing`);
  disposeArchitecture(low);
}

function boundsOfFootprint(building: BuildingRecord): [number, number, number, number] {
  const xs = building.footprint.map((point) => point[0]);
  const zs = building.footprint.map((point) => point[1]);
  return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
}

function checkMappedWall(building: BuildingRecord): void {
  const low = checkLayer(building, 0);
  assert.deepEqual(meshes(low).map((mesh) => mesh.name), ['mapped wall footprint', 'mapped wall coping']);
  low.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(low);
  const [minX, maxX, minZ, maxZ] = boundsOfFootprint(building);
  assert(Math.abs(box.min.x - minX) < 0.3 && Math.abs(box.max.x - maxX) < 0.3,
    `${building.name}: wall X bounds no longer follow OSM footprint`);
  assert(Math.abs(box.min.z - minZ) < 0.3 && Math.abs(box.max.z - maxZ) < 0.3,
    `${building.name}: wall Z bounds no longer follow OSM footprint`);
  assert(Math.abs(box.max.y - building.height) < 0.3, `${building.name}: wrong wall height`);
  disposeArchitecture(low);
}

function inPolygon(x: number, z: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function edgeDistance(x: number, z: number, polygon: [number, number][]): number {
  let nearest = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / Math.max(1e-9, dx * dx + dz * dz)));
    nearest = Math.min(nearest, Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz));
  }
  return nearest;
}

function checkCourtyardVoid(building: BuildingRecord): void {
  const low = checkLayer(building, 0);
  assert(meshes(low).some((mesh) => mesh.name === 'mapped courtyard wings' || mesh.name === 'mapped wall footprint'),
    `${building.name}: expected exact source footprint`);
  low.updateMatrixWorld(true);
  const [minX, maxX, minZ, maxZ] = boundsOfFootprint(building);
  let openPoint: [number, number] | null = null;
  let solidPoint: [number, number] | null = null;
  for (let ix = 1; ix < 80; ix++) for (let iz = 1; iz < 80; iz++) {
    const x = minX + (maxX - minX) * ix / 80;
    const z = minZ + (maxZ - minZ) * iz / 80;
    if (edgeDistance(x, z, building.footprint) < 0.15) continue;
    if (inPolygon(x, z, building.footprint)) solidPoint ??= [x, z];
    else openPoint ??= [x, z];
  }
  assert(openPoint && solidPoint, `${building.name}: no testable courtyard gap`);
  const ray = new THREE.Raycaster();
  const hitsAt = ([x, z]: [number, number]) => {
    ray.set(new THREE.Vector3(x, building.height + 10, z), new THREE.Vector3(0, -1, 0));
    return ray.intersectObjects(meshes(low), false);
  };
  assert(hitsAt(solidPoint).length > 0, `${building.name}: mapped courtyard wing is missing`);
  assert.equal(hitsAt(openPoint).length, 0, `${building.name}: roof fills the source courtyard void`);
  disposeArchitecture(low);
}

const plainRoof = buildArchitecture(record({}), 0);
const plainRoofVertexCount = meshes(plainRoof).find((mesh) => mesh.name === 'curved glazed roof')
  ?.geometry.getAttribute('position').count;
assert(plainRoofVertexCount && plainRoofVertexCount > 0, 'single roof reference is missing');
disposeArchitecture(plainRoof);

function checkCornerRoof(building: BuildingRecord): void {
  const low = checkLayer(building, 0);
  const roof = meshes(low).find((mesh) => mesh.name === 'curved glazed roof');
  assert(roof, `${building.name}: roof is missing`);
  const positions = roof.geometry.getAttribute('position');
  assert.equal(positions.count, plainRoofVertexCount * 3,
    `${building.name}: expected three complete roof tiers`);
  const tiers = Array.from({ length: 3 }, (_, tier) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let eave = Infinity, top = -Infinity;
    for (let i = tier * plainRoofVertexCount; i < (tier + 1) * plainRoofVertexCount; i++) {
      const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      eave = Math.min(eave, y); top = Math.max(top, y);
    }
    return { width: maxX - minX, depth: maxZ - minZ, eave, top };
  });
  assert(tiers[0].width < building.width * 1.2 && tiers[0].depth < building.depth * 1.2,
    `${building.name}: bottom roof exceeds its compact tower footprint`);
  for (let tier = 1; tier < tiers.length; tier++) {
    assert(tiers[tier].width < tiers[tier - 1].width * 0.9
      && tiers[tier].depth < tiers[tier - 1].depth * 0.9,
    `${building.name}: roof tiers must narrow toward the crown`);
    assert(tiers[tier].eave > tiers[tier - 1].top + 0.2,
      `${building.name}: roof tiers do not rise separately`);
    assert(tiers[tier].top - tiers[tier].eave < tiers[tier - 1].top - tiers[tier - 1].eave - 0.05,
      `${building.name}: roof heights should taper toward the crown`);
  }
  assert(Math.abs(tiers[2].top - building.height) < 0.05,
    `${building.name}: third roof does not reach the recorded height`);
  disposeArchitecture(low);
}

const taihe = data?.buildings.find((building) => building.name === '太和殿') ?? record({ name: '太和殿', height: 35.05, roofHeight: 9.5, doubleRoof: true });
const qianqing = data?.buildings.find((building) => building.name === '乾清宫') ?? record({ name: '乾清宫', height: 11, roofHeight: 4.62, doubleRoof: true });
const wumen = data?.buildings.find((building) => building.name === '午门') ?? record({ name: '午门', kind: 'gate', width: 190, depth: 107, height: 25, roofHeight: 6 });
const qinan = data?.buildings.find((building) => building.name === '钦安殿')
  ?? record({ name: '钦安殿', width: 24, depth: 13, height: 11.2, roofHeight: 4.5, roofKind: 'flat', doubleRoof: true });
const corner = data?.buildings.find((building) => /角楼/.test(building.name))
  ?? record({ name: '东北角楼', kind: 'tower', width: 28, depth: 28, height: 24, roofHeight: 8 });

for (const major of [taihe, qianqing, wumen, qinan, corner]) {
  checkTop(major);
  for (const level of [1, 2] as const) {
    const layer = checkLayer(major, level);
    disposeArchitecture(layer);
  }
}
checkPortal(wumen);
checkCornerRoof(corner);
{
  const low = checkLayer(qinan, 0);
  const roof = meshes(low).find((mesh) => mesh.name === 'curved glazed roof');
  assert(roof, '钦安殿 roof is missing');
  const positions = roof.geometry.getAttribute('position');
  const distinctHeights = new Set<number>();
  const top: [number, number][] = [];
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i);
    distinctHeights.add(Math.round(y * 100) / 100);
    if (Math.abs(y - qinan.height) < 0.02) top.push([positions.getX(i), positions.getZ(i)]);
  }
  assert(distinctHeights.size >= 12, '钦安殿 should have two sloping roof tiers');
  assert(top.length >= 4, '钦安殿 lacks the truncated flat crown');
  assert(Math.max(...top.map((point) => point[1])) - Math.min(...top.map((point) => point[1])) > 1,
    '钦安殿 top collapsed to a ridge');
  disposeArchitecture(low);
}

if (data) {
  for (const platform of data.buildings.filter((building) => building.kind === 'platform')) {
    const low = checkLayer(platform, 0);
    assert.deepEqual(meshes(low).map((mesh) => mesh.name), ['mapped three-tier stone platform'],
      `${platform.name}: platform should have three stone tiers and no roof`);
    low.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(low);
    assert(Math.abs(box.max.y - platform.height) < 0.05, `${platform.name}: platform height mismatch`);
    const topVertices: THREE.Vector3[] = [];
    const elevations = new Set<number>();
    const stone = meshes(low)[0];
    const positions = stone.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getY(i);
      elevations.add(Math.round(y * 100) / 100);
      if (Math.abs(y - platform.height) < 0.01) {
        topVertices.push(new THREE.Vector3(positions.getX(i), y, positions.getZ(i)).applyMatrix4(stone.matrixWorld));
      }
    }
    assert(elevations.size >= 4, `${platform.name}: terraces collapsed into one slab`);
    const [minX, maxX, minZ, maxZ] = boundsOfFootprint(platform);
    assert(Math.abs(Math.min(...topVertices.map((point) => point.x)) - minX) < 0.05
      && Math.abs(Math.max(...topVertices.map((point) => point.x)) - maxX) < 0.05
      && Math.abs(Math.min(...topVertices.map((point) => point.z)) - minZ) < 0.05
      && Math.abs(Math.max(...topVertices.map((point) => point.z)) - maxZ) < 0.05,
    `${platform.name}: walking surface changed from sourced footprint`);
    disposeArchitecture(low);
    const mid = checkLayer(platform, 1);
    assert.deepEqual(meshes(mid).map((mesh) => mesh.name).sort(),
      ['platform marble railing posts', 'platform marble railing', 'south marble stair flight'].sort(),
      `${platform.name}: platform must have rails and stairs without palace doors`);
    const c = Math.cos(platform.angle), s = Math.sin(platform.angle);
    const local = platform.footprint.map(([x, z]) => {
      const dx = x - platform.center[0], dz = z - platform.center[1];
      return [dx * c - dz * s, dx * s + dz * c] as const;
    });
    const crossings: number[] = [];
    for (let i = 0; i < local.length; i++) {
      const a = local[i], b = local[(i + 1) % local.length];
      if ((a[0] <= 0 && b[0] >= 0) || (a[0] >= 0 && b[0] <= 0)) {
        const t = -a[0] / (b[0] - a[0]);
        if (Number.isFinite(t) && t >= 0 && t <= 1) crossings.push(a[1] + (b[1] - a[1]) * t);
      }
    }
    const centralSouth = Math.max(...crossings);
    const stairs = meshes(mid).find((mesh) => mesh.name === 'south marble stair flight')!;
    stairs.geometry.computeBoundingBox();
    assert(Math.abs(stairs.geometry.boundingBox!.min.z - centralSouth) < 0.05,
      `${platform.name}: stairs do not join the central southern platform edge`);
    assert(stairs.geometry.boundingBox!.max.z - centralSouth >= platform.height * 1.7,
      `${platform.name}: stairs are too short for the terrace height`);
    disposeArchitecture(mid);
    const high = checkLayer(platform, 2);
    assert.equal(meshes(high).length, 0, `${platform.name}: stone terrace has unnecessary high LOD`);
    disposeArchitecture(high);
  }
  for (const actualCorner of data.buildings.filter((building) => building.landmark === 'corner')) {
    checkTop(actualCorner);
    checkCornerRoof(actualCorner);
  }
  const walls = data.buildings.filter((building) => building.kind === 'wall').sort((a, b) => b.width - a.width);
  assert(walls.length > 0, 'Palace source has no walls');
  checkMappedWall(walls[0]);
  const courtyard = data.buildings.find((building) => building.name === '四合院墙1')
    ?? data.buildings.find((building) => building.kind === 'building' && building.width * building.depth > 500 && building.footprint.length > 8
      && (() => { let area = 0; for (let i = 0; i < building.footprint.length; i++) {
        const a = building.footprint[i], b = building.footprint[(i + 1) % building.footprint.length];
        area += a[0] * b[1] - b[0] * a[1];
      } return Math.abs(area / 2) / (building.width * building.depth) < 0.2; })());
  if (courtyard) checkCourtyardVoid(courtyard);
  for (const building of data.buildings) {
    const low = checkLayer(building, 0);
    disposeArchitecture(low);
  }
}

console.log(`Geometry validation passed: ${checked} LOD layers${data ? ` across ${data.buildings.length} mapped buildings` : ' using fixtures'}.`);
