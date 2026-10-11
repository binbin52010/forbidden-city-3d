export type RoofKind = 'hipped' | 'gabled' | 'half-hipped' | 'pyramidal' | 'round' | 'flat' | 'luding';
export interface BuildingRecord {
  id: string;
  name: string;
  zone: string;
  footprint: [number, number][];
  center: [number, number];
  width: number;
  depth: number;
  angle: number;
  height: number;
  roofHeight: number;
  roofKind: RoofKind;
  roofColor: string;
  kind: 'building' | 'wall' | 'gate' | 'tower' | 'pavilion' | 'platform';
  landmark?: string;
  confidence: 'documented' | 'mapped' | 'estimated';
  source: string;
  description?: string;
  doubleRoof?: boolean;
}
export interface PalaceData {
  metadata: { fetchedAt: string; boundaryId: number; boundaryVersion: number; origin: [number, number]; projection: string; attribution: string; featureCount: number; };
  boundary: [number, number][];
  water: [number, number][][];
  waterAreas?: { outer: [number, number][]; holes: [number, number][][]; waterType: string; source: string }[];
  waterLines: [number, number][][];
  paths: [number, number][][];
  buildings: BuildingRecord[];
}
export type Quality = 'auto' | 'high' | 'low';
export interface UIActions {
  select: (id: string) => void;
  overview: () => void;
  top: () => void;
  walk: () => void;
  quality: (quality: Quality) => void;
  labels: (visible: boolean) => void;
}
