import type { Building } from "../config/agents";
import { CAMPUS_BUILDINGS, CAMPUS_CROSSROADS } from "../config/campus-buildings";

interface Waypoint {
  id: string;
  x: number;
  y: number;
  connections: string[];
}

// Building entrances (below each building)
const CAMPUS_ENTRANCES: Record<Building, { x: number; y: number }> = {
  newsroom: { x: 220, y: 260 },
  exchange: { x: 1910, y: 270 },
  lounge: { x: 1020, y: 690 },
  pit: { x: 225, y: 1170 },
  workshop: { x: 1900, y: 1210 },
  path_left: { x: 500, y: 650 },
  path_center: { x: 1100, y: 650 },
  path_right: { x: 1600, y: 650 },
};

// Intersection nodes forming the campus path network
// Star topology: central crossroads with spokes to each building
const CAMPUS_INTERSECTIONS = [
  { id: "crossroads", ...CAMPUS_CROSSROADS },
  // Intermediate waypoints along spokes
  { id: "north_west", x: 400, y: 350 },
  { id: "north_east", x: 1700, y: 350 },
  { id: "south_west", x: 400, y: 950 },
  { id: "south_east", x: 1700, y: 950 },
  // Lounge approach (short spoke south from crossroads)
  { id: "lounge_approach", x: 1020, y: 650 },
];

function buildCampusGraph(): Map<string, Waypoint> {
  const graph = new Map<string, Waypoint>();

  for (const [building, pos] of Object.entries(CAMPUS_ENTRANCES)) {
    graph.set(`bld_${building}`, {
      id: `bld_${building}`,
      x: pos.x,
      y: pos.y,
      connections: [],
    });
  }

  for (const node of CAMPUS_INTERSECTIONS) {
    graph.set(node.id, { ...node, connections: [] });
  }

  const connect = (a: string, b: string) => {
    graph.get(a)!.connections.push(b);
    graph.get(b)!.connections.push(a);
  };

  // Crossroads → intermediate junctions
  connect("crossroads", "north_west");
  connect("crossroads", "north_east");
  connect("crossroads", "south_west");
  connect("crossroads", "south_east");
  connect("crossroads", "lounge_approach");

  // Buildings → nearest junction
  connect("bld_newsroom", "north_west");
  connect("bld_exchange", "north_east");
  connect("bld_pit", "south_west");
  connect("bld_workshop", "south_east");
  connect("bld_lounge", "lounge_approach");

  // Path locations → crossroads
  connect("bld_path_left", "north_west");
  connect("bld_path_left", "south_west");
  connect("bld_path_center", "crossroads");
  connect("bld_path_right", "north_east");
  connect("bld_path_right", "south_east");

  return graph;
}

const CAMPUS_GRAPH = buildCampusGraph();

function distance(a: Waypoint, b: Waypoint): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function dijkstra(startId: string, endId: string): string[] {
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const visited = new Set<string>();

  for (const id of CAMPUS_GRAPH.keys()) {
    dist.set(id, Infinity);
    prev.set(id, null);
  }
  dist.set(startId, 0);

  while (true) {
    let minDist = Infinity;
    let current: string | null = null;

    for (const [id, d] of dist) {
      if (!visited.has(id) && d < minDist) {
        minDist = d;
        current = id;
      }
    }

    if (current === null || current === endId) break;
    visited.add(current);

    const node = CAMPUS_GRAPH.get(current)!;
    for (const neighborId of node.connections) {
      if (visited.has(neighborId)) continue;
      const neighbor = CAMPUS_GRAPH.get(neighborId)!;
      const alt = dist.get(current)! + distance(node, neighbor);
      if (alt < dist.get(neighborId)!) {
        dist.set(neighborId, alt);
        prev.set(neighborId, current);
      }
    }
  }

  const path: string[] = [];
  let current: string | null = endId;
  while (current !== null) {
    path.unshift(current);
    current = prev.get(current) ?? null;
  }

  return path[0] === startId ? path : [];
}

export interface PathPoint {
  x: number;
  y: number;
}

export function findCampusPath(from: Building, to: Building): PathPoint[] {
  if (from === to) return [];

  const startId = `bld_${from}`;
  const endId = `bld_${to}`;
  const nodeIds = dijkstra(startId, endId);

  return nodeIds.slice(1).map((id) => {
    const node = CAMPUS_GRAPH.get(id)!;
    return { x: node.x, y: node.y };
  });
}

export function getCampusBuildingEntrance(building: Building): PathPoint {
  return CAMPUS_ENTRANCES[building];
}

export function getCampusPathSegments(): { from: PathPoint; to: PathPoint }[] {
  const segments: { from: PathPoint; to: PathPoint }[] = [];
  const seen = new Set<string>();

  for (const [id, node] of CAMPUS_GRAPH) {
    for (const connId of node.connections) {
      const key = [id, connId].sort().join("-");
      if (seen.has(key)) continue;
      seen.add(key);
      const conn = CAMPUS_GRAPH.get(connId)!;
      segments.push({
        from: { x: node.x, y: node.y },
        to: { x: conn.x, y: conn.y },
      });
    }
  }

  return segments;
}
