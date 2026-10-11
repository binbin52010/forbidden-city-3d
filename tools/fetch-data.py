#!/usr/bin/env python3
"""Freeze OSM geometry for the Forbidden City and build the browser scene data.

The raw snapshot and derived layout are both ODbL 1.0 data.  This script uses
only OpenStreetMap API data for geometry; Palace Museum pages are consulted for
the few explicitly documented architectural overrides listed below.

Run with: python tools/fetch-data.py
Requires: shapely (tested with 2.0.7).
"""

from __future__ import annotations

import json
import math
import os
import re
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import linemerge, polygonize, unary_union


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "public" / "data"
RELATION_ID = 9511883
GARDEN_WAY_ID = 30802178  # OSM leisure=garden polygon for 御花园.
CHENGQIAN_HALL_WAY_ID = 40631340
CHENGQIAN_GATE_WAY_ID = 42623372
TAIJI_HALL_WAY_ID = 40631788
BOUNDARY_URL = f"https://api.openstreetmap.org/api/0.6/relation/{RELATION_ID}/full"
# The rectangle is deliberately just larger than the historic OSM boundary.
# It is only an API retrieval window; the relation polygon is the actual filter.
BBOX = (116.3847, 39.9105, 116.3968, 39.9223)
MAP_URL = "https://api.openstreetmap.org/api/0.6/map?bbox=" + ",".join(str(v) for v in BBOX)
USER_AGENT = "ForbiddenCity3D/1.0 (educational OSM data export; github.com)"
ATTRIBUTION = "© OpenStreetMap contributors (ODbL 1.0)"

# WGS84 local tangent approximation, accurate enough over a one-kilometre site.
# Origin is the centre of the OSM boundary bounds, set after fetching geometry.
ORIGIN_LON = 0.0
ORIGIN_LAT = 0.0
METRES_PER_DEG_LON = 0.0
METRES_PER_DEG_LAT = 0.0

LANDMARK_NAMES = {
    "午门": "wumen",
    "太和殿": "taihe",
    "中和殿": "zhonghe",
    "保和殿": "baohe",
    "太和门": "taihemen",
    "神武门": "shenwumen",
    "乾清门": "qianqingmen",
    "乾清宫": "qianqing",
    "交泰殿": "jiaotai",
    "坤宁宫": "kunning",
    "皇极殿": "huangji",
    "宁寿宫": "ningshou",
    "慈宁宫": "cining",
    "钦安殿": "yuhuayuan",  # garden focus point, not the garden's full extent
}
CORNER_TOWER_NAMES = {"西南城墙", "东南城墙", "西北城墙", "东北城墙"}
PLATFORM_WAY_IDS = {
    638449433: ("三台南段", 8.13),
    638467894: ("三台北段", 8.13),
    638981252: ("后三宫台基", 2.0),
    638981261: ("乾清宫前月台", 1.0),
    638807694: ("乾清门北石台", 3.0),
}
# Official museum architecture pages give the roof forms and, where noted,
# measured heights. Values marked estimated remain model display estimates.
LANDMARK_OVERRIDES: dict[str, dict[str, Any]] = {
    "太和殿": {"height": 35.05, "roof": "hipped", "double": True, "documentedHeight": True,
                "url": "https://www.dpm.org.cn/show/225724.html"},
    "保和殿": {"height": 29.50, "roof": "half-hipped", "double": True,
                "documentedHeight": True, "url": "https://www.dpm.org.cn/explore/building/236434.html"},
    "乾清宫": {"height": 24.0, "roof": "hipped", "double": True,
                "url": "https://www.dpm.org.cn/show/225721.html"},
    "交泰殿": {"height": 20.6, "roof": "pyramidal", "double": False,
                "url": "https://www.dpm.org.cn/explore/building/236467.html"},
    "坤宁宫": {"height": 21.0, "roof": "hipped", "double": True,
                "url": "https://www.dpm.org.cn/explore/building/236487.html"},
    "午门": {"height": 37.95, "roof": "hipped", "double": True,
             "documentedHeight": True, "url": "https://www.dpm.org.cn/explore/building/236454.html",
             "heightUrl": "https://s.visitbeijing.com.cn/attraction/120916"},
    "太和门": {"height": 23.8, "roof": "half-hipped", "double": True,
                "url": "https://www.dpm.org.cn/explore/building/236439.html"},
    "乾清门": {"height": 16.0, "roof": "half-hipped", "double": False,
                "documentedHeight": True, "url": "https://www.dpm.org.cn/explore/building/236473.html"},
    "钦安殿": {"roof": "luding", "double": True,
                "url": "https://www.dpm.org.cn/explore/building/236494.html"},
}


def fetch_xml(url: str) -> ET.Element:
    """Fetch without local cache so each run records a new OSM snapshot."""
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/xml, text/xml"},
    )
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                return ET.fromstring(response.read())
        except (urllib.error.URLError, ET.ParseError, TimeoutError) as error:
            last_error = error
            if attempt < 3:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Cannot fetch {url}: {last_error}")


def tags_of(element: ET.Element) -> dict[str, str]:
    return {tag.attrib["k"]: tag.attrib["v"] for tag in element.findall("tag")}


def parse_osm(root: ET.Element) -> tuple[dict[int, dict], dict[int, dict], dict[int, dict]]:
    nodes: dict[int, dict] = {}
    ways: dict[int, dict] = {}
    relations: dict[int, dict] = {}
    for element in root:
        if element.tag not in {"node", "way", "relation"}:
            continue
        item: dict[str, Any] = {
            "id": int(element.attrib["id"]),
            "version": int(element.attrib.get("version", "1")),
            "timestamp": element.attrib.get("timestamp", ""),
            "tags": tags_of(element),
        }
        if element.tag == "node":
            item["lon"] = float(element.attrib["lon"])
            item["lat"] = float(element.attrib["lat"])
            nodes[item["id"]] = item
        elif element.tag == "way":
            item["nodes"] = [int(node.attrib["ref"]) for node in element.findall("nd")]
            ways[item["id"]] = item
        else:
            item["members"] = [
                {"type": member.attrib["type"], "ref": int(member.attrib["ref"]),
                 "role": member.attrib.get("role", "")}
                for member in element.findall("member")
            ]
            relations[item["id"]] = item
    return nodes, ways, relations


def boundary_polygon(relation: dict, ways: dict[int, dict], nodes: dict[int, dict]) -> Polygon:
    lines = []
    for member in relation["members"]:
        if member["type"] != "way" or member["role"] != "outer":
            continue
        way = ways[member["ref"]]
        lines.append(LineString([(nodes[node_id]["lon"], nodes[node_id]["lat"])
                                 for node_id in way["nodes"]]))
    if not lines:
        raise ValueError("OSM palace relation has no outer boundary ways")
    merged = linemerge(unary_union(lines))
    polygons = list(polygonize(merged))
    if len(polygons) != 1:
        raise ValueError(f"Expected one palace boundary polygon, found {len(polygons)}")
    polygon = polygons[0]
    if not polygon.is_valid:
        raise ValueError("OSM palace boundary is invalid")
    return polygon


def configure_projection(boundary: Polygon) -> None:
    global ORIGIN_LON, ORIGIN_LAT, METRES_PER_DEG_LON, METRES_PER_DEG_LAT
    west, south, east, north = boundary.bounds
    ORIGIN_LON = (west + east) / 2
    ORIGIN_LAT = (south + north) / 2
    lat_radians = math.radians(ORIGIN_LAT)
    major_axis = 6378137.0
    eccentricity_squared = 6.69437999014e-3
    sin_lat = math.sin(lat_radians)
    prime_vertical = major_axis / math.sqrt(1 - eccentricity_squared * sin_lat * sin_lat)
    meridian = major_axis * (1 - eccentricity_squared) / (
        1 - eccentricity_squared * sin_lat * sin_lat
    ) ** 1.5
    METRES_PER_DEG_LON = math.pi / 180 * prime_vertical * math.cos(lat_radians)
    METRES_PER_DEG_LAT = math.pi / 180 * meridian


def project(lon: float, lat: float) -> tuple[float, float]:
    # x points east; z points south. Three's scene y is vertical.
    return ((lon - ORIGIN_LON) * METRES_PER_DEG_LON,
            -(lat - ORIGIN_LAT) * METRES_PER_DEG_LAT)


def rounded_point(point: tuple[float, float]) -> list[float]:
    return [round(point[0], 3), round(point[1], 3)]


def parse_metres(raw: str | None) -> float | None:
    if not raw:
        return None
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(?:m|metres?|米)?\s*", raw, re.I)
    return float(match.group(1)) if match else None


def roof_kind(tags: dict[str, str], kind: str, name: str) -> str:
    documented = {
        "太和殿": "hipped",  # 重檐庑殿顶
        "中和殿": "pyramidal",  # 四角攒尖顶
        "保和殿": "half-hipped",  # 重檐歇山顶
        "乾清宫": "hipped",  # 重檐庑殿顶
        "午门": "hipped",  # central gatehouse
    }
    if name in documented:
        return documented[name]
    osm_roof = tags.get("roof:shape", "").lower()
    mapping = {
        "hipped": "hipped", "gabled": "gabled", "half-hipped": "half-hipped",
        "pyramidal": "pyramidal", "dome": "round", "round": "round",
        "flat": "flat", "skillion": "flat",
    }
    if osm_roof in mapping:
        return mapping[osm_roof]
    if kind == "pavilion":
        return "pyramidal"
    if kind in {"tower", "gate"} or name.endswith("殿") or name.endswith("宫"):
        return "hipped"
    if kind == "wall":
        return "flat"
    return "gabled"


def roof_color(tags: dict[str, str], kind: str) -> str:
    raw = tags.get("roof:colour", "").strip()
    if re.fullmatch(r"#[0-9a-fA-F]{6}", raw):
        return raw.lower()
    names = {"lightgrey": "#b8b9b5", "darkgrey": "#676b70", "grey": "#898d8d"}
    if raw.lower() in names:
        return names[raw.lower()]
    return "#d4a84b" if kind != "wall" else "#aa4431"


def feature_kind(tags: dict[str, str], name: str) -> str:
    osm_kind = tags.get("building", "")
    # OSM names the four square corner-tower bases as corner walls.
    if name in CORNER_TOWER_NAMES:
        return "tower"
    if re.search(r"墙\d*$", name):
        return "wall"
    if osm_kind == "wall":
        return "wall"
    if osm_kind in {"gatehouse", "gate"} or name.endswith("门"):
        return "gate"
    if osm_kind == "tower" or "角楼" in name:
        return "tower"
    if "亭" in name or osm_kind in {"pavilion", "gazebo"}:
        return "pavilion"
    return "building"


def garden_polygon(ways: dict[int, dict], nodes: dict[int, dict]) -> Polygon:
    """Use the mapped garden boundary rather than a broad latitude band."""
    way = ways.get(GARDEN_WAY_ID)
    if not way or way["tags"].get("leisure") != "garden" or way["tags"].get("name") != "御花园":
        raise RuntimeError("OSM 御花园 garden way is missing or changed")
    try:
        points = [(nodes[node_id]["lon"], nodes[node_id]["lat"]) for node_id in way["nodes"]]
    except KeyError as error:
        raise RuntimeError("OSM 御花园 garden way has missing nodes") from error
    if len(points) < 4 or points[0] != points[-1]:
        raise RuntimeError("OSM 御花园 garden way is not a closed polygon")
    polygon = Polygon(points)
    if not polygon.is_valid or polygon.area <= 0:
        raise RuntimeError("OSM 御花园 garden polygon is invalid")
    return polygon


def zone_for(lon: float, lat: float, kind: str, name: str, near_boundary: bool,
             garden: Polygon) -> str:
    if kind in {"wall", "gate", "tower"} and near_boundary:
        return "城垣"
    if "宁寿" in name or "皇极" in name:
        return "宁寿宫"
    if "慈宁" in name:
        return "慈宁宫"
    if garden.covers(Point(lon, lat)):
        return "御花园"
    if lat <= 39.91755:
        return "外朝"
    if lon >= 116.3925:
        return "宁寿宫"
    if lon <= 116.38845:
        return "慈宁宫"
    if lon >= 116.3915:
        return "东六宫"
    if lon <= 116.3899:
        return "西六宫"
    return "内廷"


def oriented_box(polygon: Polygon) -> tuple[float, float, float]:
    rect = polygon.minimum_rotated_rectangle
    corners = list(rect.exterior.coords)[:4]
    edges = []
    for index in range(4):
        first, second = corners[index], corners[(index + 1) % 4]
        dx, dz = second[0] - first[0], second[1] - first[1]
        edges.append((math.hypot(dx, dz), dx, dz))
    width, dx, dz = max(edges, key=lambda item: item[0])
    depth = min(edge[0] for edge in edges)
    # local +x becomes (cos angle, -sin angle) in world x,z.
    angle = math.atan2(-dz, dx)
    angle = (angle + math.pi / 2) % math.pi - math.pi / 2
    return width, depth, angle


def inferred_height(kind: str, name: str, width: float, depth: float,
                    near_boundary: bool) -> float:
    if kind == "wall":
        return 10.0 if near_boundary else 5.0
    if kind == "gate":
        return min(25.0, max(10.0, 8.0 + max(width, depth) * 0.15))
    if kind == "tower":
        return 24.0
    if kind == "pavilion":
        return 9.0
    span = min(width, depth)
    estimate = 4.2 + span * 0.30
    if name.endswith("殿") or name.endswith("宫"):
        estimate += 3.0
    return min(22.0, max(5.0, estimate))


def building_record(way: dict, polygon: Polygon, boundary_m: Polygon,
                    garden: Polygon) -> dict[str, Any]:
    tags = way["tags"]
    name = tags.get("name", "")
    width, depth, angle = oriented_box(polygon)
    center_m = polygon.centroid
    lon = center_m.x / METRES_PER_DEG_LON + ORIGIN_LON
    lat = ORIGIN_LAT - center_m.y / METRES_PER_DEG_LAT
    near_boundary = polygon.distance(boundary_m.boundary) <= 15.0
    kind = feature_kind(tags, name)
    platform = PLATFORM_WAY_IDS.get(way["id"])
    if platform:
        kind = "platform"
    zone = zone_for(lon, lat, kind, name, near_boundary, garden)
    mapped_height = parse_metres(tags.get("height"))
    height = mapped_height or inferred_height(kind, name, width, depth, near_boundary)
    override = LANDMARK_OVERRIDES.get(name, {})
    if "height" in override:
        height = override["height"]
    if name in CORNER_TOWER_NAMES:
        height = 24.0  # Consistent display estimate for all four OSM tower bases.
    if platform:
        height = platform[1]
    style = roof_kind(tags, kind, name)
    if "roof" in override:
        style = override["roof"]
    if platform:
        style = "flat"
    mapped_roof_height = parse_metres(tags.get("roof:height"))
    if kind in {"wall", "platform"}:
        roof_height = 0.0
    elif mapped_roof_height:
        roof_height = min(height * 0.55, mapped_roof_height)
    else:
        roof_height = min(height * 0.42, max(1.25, min(depth * 0.34, 6.0)))
    if name == "太和殿":
        roof_height = 9.5  # Visual approximation included within total height.
    landmark = LANDMARK_NAMES.get(name)
    if "角楼" in name:
        landmark = "corner"
    documented = bool(override.get("documentedHeight"))
    mapped = mapped_height is not None and tags.get("roof:shape") is not None
    confidence = "documented" if documented else "mapped" if mapped else "estimated"
    source = f"https://www.openstreetmap.org/way/{way['id']}"
    for key in ("url", "heightUrl"):
        if override.get(key):
            source += f"; {override[key]}"
    if platform and way["id"] in {638449433, 638467894}:
        source += "; https://www.dpm.org.cn/explore/building/236465.html"
    coords = list(polygon.exterior.coords)
    if coords[0] == coords[-1]:
        coords.pop()
    record: dict[str, Any] = {
        "id": f"osm-way-{way['id']}",
        "name": platform[0] if platform else name.replace("城墙", "角楼") if name in CORNER_TOWER_NAMES else name or f"未命名建筑 {way['id']}",
        "zone": zone,
        "footprint": [rounded_point(point) for point in coords],
        "center": rounded_point((center_m.x, center_m.y)),
        "width": round(width, 3),
        "depth": round(depth, 3),
        "angle": round(angle, 6),
        "height": round(height, 3),
        "roofHeight": round(roof_height, 3),
        "roofKind": style,
        "roofColor": "#d9c8a6" if platform else roof_color(tags, kind),
        "kind": kind,
        "confidence": confidence,
        "source": source,
    }
    if landmark:
        record["landmark"] = landmark
    if platform:
        record["description"] = "OSM 轮廓对应石台或月台；高度是展示近似值，表面不生成屋顶。"
    elif name == "太和殿":
        record["description"] = "外朝中心大殿；通高 35.05 米，重檐庑殿顶。"
    elif name == "钦安殿":
        record["description"] = "御花园内的建筑；此标记仅用于聚焦御花园区域。"
    if way["id"] in {CHENGQIAN_HALL_WAY_ID, CHENGQIAN_GATE_WAY_ID}:
        # OSM currently writes 承干; the Palace Museum uses 承乾 for both.
        record["name"] = "承乾宫" if way["id"] == CHENGQIAN_HALL_WAY_ID else "承乾门"
        record["description"] = f"故宫博物院用名；原始 OSM 标签为{name}。"
        record["source"] += "; https://www.dpm.org.cn/explore/building/236438.html"
    elif way["id"] == TAIJI_HALL_WAY_ID:
        record["description"] = "太极殿旧称启祥宫；此轮廓是主殿，不代表整个宫区。"
        record["source"] += "; https://www.dpm.org.cn/explore/building/236475.html"
    if "double" in override:
        record["doubleRoof"] = override["double"]
    if name in CORNER_TOWER_NAMES:
        record["landmark"] = "corner"
        record["description"] = "宫城四隅角楼；位置与基底取自 OSM 中对应的方形城墙轮廓，复杂三重檐屋顶及高度为展示近似。"
        record["roofKind"] = "half-hipped"
        record["source"] += "; https://www.dpm.org.cn/explore/building/236522.html"
    return record


def add_missing_central_hall(buildings: list[dict[str, Any]]) -> None:
    """OSM currently omits Zhonghe Hall; place one original approximate hall."""
    if any(item.get("landmark") == "zhonghe" for item in buildings):
        return
    indexed = {item.get("landmark"): item for item in buildings if item.get("landmark")}
    south = indexed.get("taihe")
    north = indexed.get("baohe")
    if not south or not north:
        raise RuntimeError("Cannot place missing Zhonghe Hall without adjacent OSM halls")
    centre_x = (south["center"][0] + north["center"][0]) / 2
    centre_z = (south["center"][1] + north["center"][1]) / 2
    side = 24.0  # approximate footprint; Palace Museum describes a square hall.
    half = side / 2
    inferred = {
        "id": "inferred-zhonghe",
        "name": "中和殿",
        "zone": "外朝",
        "footprint": [
            rounded_point((centre_x - half, centre_z - half)),
            rounded_point((centre_x + half, centre_z - half)),
            rounded_point((centre_x + half, centre_z + half)),
            rounded_point((centre_x - half, centre_z + half)),
        ],
        "center": rounded_point((centre_x, centre_z)),
        "width": side,
        "depth": side,
        "angle": 0.0,
        "height": 19.0,
        "roofHeight": 5.0,
        "roofKind": "pyramidal",
        "roofColor": "#d4a84b",
        "kind": "building",
        "landmark": "zhonghe",
        "confidence": "estimated",
        "source": "https://www.dpm.org.cn/explore/building/236464.html; https://s.visitbeijing.com.cn/attraction/120829; https://www.openstreetmap.org/way/638449347; https://www.openstreetmap.org/way/638473398",
        "description": "外朝三大殿之一；高度参考北京市旅游资料，OSM 缺少轮廓，此模型按相邻殿宇轴线和故宫博物院记载的方形殿式近似。",
    }
    buildings.append(inferred)


def line_sequences(geometry: Any) -> list[LineString]:
    if geometry.is_empty:
        return []
    if geometry.geom_type == "LineString":
        return [geometry]
    if geometry.geom_type == "Polygon":
        return [geometry.exterior]
    if geometry.geom_type in {"MultiLineString", "GeometryCollection", "MultiPolygon"}:
        output = []
        for item in geometry.geoms:
            output.extend(line_sequences(item))
        return output
    return []


def polygon_sequences(geometry: Any) -> list[Polygon]:
    if geometry.is_empty:
        return []
    if geometry.geom_type == "Polygon":
        return [geometry]
    if geometry.geom_type in {"MultiPolygon", "GeometryCollection"}:
        output = []
        for item in geometry.geoms:
            output.extend(polygon_sequences(item))
        return output
    return []


def assemble_lines(ways: dict[int, dict], nodes: dict[int, dict],
                   boundary: Polygon) -> tuple[list[list[list[float]]], list[dict[str, Any]], list[list[list[float]]], list[list[list[float]]]]:
    water: list[list[list[float]]] = []
    water_areas: list[dict[str, Any]] = []
    water_lines: list[list[list[float]]] = []
    paths: list[list[list[float]]] = []
    seen_water: set[tuple] = set()
    seen_water_areas: set[tuple] = set()
    seen_water_lines: set[tuple] = set()
    seen_paths: set[tuple] = set()
    path_types = {"footway", "pedestrian", "path", "steps", "living_street"}
    water_extent = boundary.buffer(115.0)
    for way in ways.values():
        tags = way["tags"]
        is_water_polygon = tags.get("natural") == "water"
        is_water_line = "waterway" in tags
        is_path = tags.get("highway") in path_types
        if not (is_water_polygon or is_water_line or is_path):
            continue
        points = [project(nodes[node_id]["lon"], nodes[node_id]["lat"])
                  for node_id in way["nodes"] if node_id in nodes]
        if len(points) < 2:
            continue
        if is_water_polygon and points[0] == points[-1] and len(points) > 3:
            polygon = Polygon(points)
            if not polygon.is_valid:
                polygon = polygon.buffer(0)
            for area in polygon_sequences(polygon.intersection(water_extent)):
                if area.area < 4.0:
                    continue
                outer = [rounded_point(point) for point in area.exterior.simplify(0.25, preserve_topology=True).coords]
                holes = [[rounded_point(point) for point in ring.simplify(0.25, preserve_topology=True).coords]
                         for ring in area.interiors]
                canonical_area = tuple(tuple(point) for point in outer)
                if canonical_area not in seen_water_areas:
                    water_areas.append({
                        "outer": outer,
                        "holes": holes,
                        "waterType": tags.get("water", "water"),
                        "source": f"https://www.openstreetmap.org/way/{way['id']}",
                    })
                    seen_water_areas.add(canonical_area)
            for clipped_polygon in polygon_sequences(polygon.intersection(boundary)):
                if clipped_polygon.area < 4.0:
                    continue
                exterior = clipped_polygon.exterior.simplify(0.25, preserve_topology=True)
                coords = [rounded_point(point) for point in exterior.coords]
                canonical = tuple(tuple(point) for point in coords)
                if canonical not in seen_water:
                    water.append(coords)
                    seen_water.add(canonical)
        geometry = LineString(points)
        clipped = geometry.intersection(boundary)
        for line in line_sequences(clipped):
            if line.length < (4.0 if is_path else 2.0):
                continue
            simplified = line.simplify(0.25, preserve_topology=True)
            coords = [rounded_point(point) for point in simplified.coords]
            canonical = tuple(tuple(point) for point in coords)
            canonical = min(canonical, tuple(reversed(canonical)))
            if is_water_line and canonical not in seen_water_lines:
                water_lines.append(coords)
                seen_water_lines.add(canonical)
            if is_path and canonical not in seen_paths:
                paths.append(coords)
                seen_paths.add(canonical)
    return water, water_areas, water_lines, paths


def write_json(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as output:
        json.dump(payload, output, ensure_ascii=False, separators=(",", ":"))
        output.write("\n")
    os.replace(temporary, path)


def main() -> None:
    boundary_xml = fetch_xml(BOUNDARY_URL)
    map_xml = fetch_xml(MAP_URL)
    boundary_nodes, boundary_ways, boundary_relations = parse_osm(boundary_xml)
    map_nodes, map_ways, map_relations = parse_osm(map_xml)
    relation = boundary_relations.get(RELATION_ID)
    if relation is None or relation["tags"].get("wikidata") != "Q80290":
        raise RuntimeError("Unexpected OSM relation; refusing to generate incorrect palace data")
    border = boundary_polygon(relation, boundary_ways, boundary_nodes)
    configure_projection(border)
    nodes = {**map_nodes, **boundary_nodes}
    ways = {**map_ways, **boundary_ways}
    relations = {**map_relations, **boundary_relations}
    garden = garden_polygon(ways, nodes)
    border_m = Polygon([project(lon, lat) for lon, lat in border.exterior.coords])
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

    candidates: list[tuple[dict, Polygon]] = []
    invalid_count = 0
    for way in ways.values():
        if "building" not in way["tags"]:
            continue
        points = [project(nodes[node_id]["lon"], nodes[node_id]["lat"])
                  for node_id in way["nodes"] if node_id in nodes]
        if len(points) < 4 or points[0] != points[-1]:
            invalid_count += 1
            continue
        polygon = Polygon(points)
        if not polygon.is_valid:
            polygon = polygon.buffer(0)
        if polygon.geom_type != "Polygon" or polygon.area < 0.5:
            invalid_count += 1
            continue
        if border_m.covers(polygon.representative_point()):
            candidates.append((way, polygon))

    # A building:part often overlaps the enclosing whole building. Exact
    # duplicate outlines can also occur under different way ids.
    candidates.sort(key=lambda pair: pair[1].area, reverse=True)
    accepted: list[tuple[dict, Polygon]] = []
    buckets: dict[tuple[int, int, int], list[Polygon]] = {}
    duplicates = 0
    for way, polygon in candidates:
        centre = polygon.centroid
        key = (round(centre.x), round(centre.y), round(polygon.area))
        same = buckets.get(key, [])
        if any(polygon.intersection(other).area / polygon.union(other).area > 0.97
               for other in same):
            duplicates += 1
            continue
        if way["tags"].get("building:part") and any(
            other.area > polygon.area * 1.1 and other.covers(polygon.representative_point())
            for _, other in accepted
        ):
            duplicates += 1
            continue
        accepted.append((way, polygon))
        buckets.setdefault(key, []).append(polygon)

    buildings = [building_record(way, polygon, border_m, garden) for way, polygon in accepted]
    add_missing_central_hall(buildings)
    buildings.sort(key=lambda item: (item["zone"], item["name"], item["id"]))
    if len(buildings) < 900:
        raise RuntimeError(f"Only {len(buildings)} buildings found; expected a full-palace extract")
    water, water_areas, water_lines, paths = assemble_lines(ways, nodes, border_m)
    boundary_points = list(border.exterior.coords)
    if boundary_points[0] == boundary_points[-1]:
        boundary_points.pop()
    palace = {
        "metadata": {
            "fetchedAt": fetched_at,
            "boundaryId": RELATION_ID,
            "boundaryVersion": relation["version"],
            "origin": [ORIGIN_LON, ORIGIN_LAT],
            "projection": "WGS84 local tangent plane; x=east, z=south, metres",
            "attribution": ATTRIBUTION,
            "featureCount": len(buildings),
        },
        "boundary": [rounded_point(project(lon, lat)) for lon, lat in boundary_points],
        "water": water,
        "waterAreas": water_areas,
        "waterLines": water_lines,
        "paths": paths,
        "buildings": buildings,
    }
    snapshot = {
        "metadata": {
            "fetchedAt": fetched_at,
            "boundaryUrl": BOUNDARY_URL,
            "mapUrl": MAP_URL,
            "boundaryId": RELATION_ID,
            "boundaryVersion": relation["version"],
            "coordinateSystem": "WGS84 longitude/latitude degrees",
            "license": "ODbL-1.0",
            "attribution": ATTRIBUTION,
        },
        "boundaryRelation": relation,
        "nodes": sorted(nodes.values(), key=lambda item: item["id"]),
        "ways": sorted(ways.values(), key=lambda item: item["id"]),
        "relations": sorted(relations.values(), key=lambda item: item["id"]),
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    write_json(DATA_DIR / "osm-source.json", snapshot)
    write_json(DATA_DIR / "palace.json", palace)
    print(json.dumps({
        "fetchedAt": fetched_at,
        "boundaryVersion": relation["version"],
        "rawNodes": len(nodes), "rawWays": len(ways),
        "buildingWaysInBoundary": len(candidates),
        "buildingRecords": len(buildings),
        "invalidBuildingWays": invalid_count,
        "deduplicated": duplicates,
        "kinds": dict(Counter(item["kind"] for item in buildings)),
        "confidence": dict(Counter(item["confidence"] for item in buildings)),
        "zones": dict(Counter(item["zone"] for item in buildings)),
        "landmarks": [item["landmark"] for item in buildings if "landmark" in item],
        "water": len(water), "waterAreas": len(water_areas),
        "waterLines": len(water_lines), "paths": len(paths),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
