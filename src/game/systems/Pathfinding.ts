import type { Building } from "../config/agents";

interface Waypoint {
  id: string;
  x: number;
  y: number;
  connections: string[];
}

// Building entrance waypoints (centered below each building)
// Shifted inward to match new building positions
const BUILDING_ENTRANCES: Record<Building, { x: number; y: number }> = {
  newsroom: { x: 290, y: 220 },
  workshop: { x: 290, y: 410 },
  exchange: { x: 630, y: 230 },
  pit: { x: 630, y: 400 },
  lounge: { x: 830, y: 320 },
};

// Path intersection nodes
const INTERSECTION_NODES = [
  { id: "cross_center", x: 460, y: 320 },
  { id: "cross_left", x: 290, y: 320 },
  { id: "cross_right", x: 630, y: 320 },
  { id: "cross_top", x: 460, y: 230 },
  { id: "cross_bottom", x: 460, y: 400 },
  { id: "lounge_junction", x: 740, y: 320 },
];

function buildGraph(): Map<string, Waypoint> {
  const graph = new Map<string, Waypoint>();

  for (const [building, pos] of Object.entries(BUILDING_ENTRANCES)) {
    graph.set(`bld_${building}`, {
      id: `bld_${building}`,
      x: pos.x,
      y: pos.y,
      connections: [],
    });
  }

  for (const node of INTERSECTION_NODES) {
    graph.set(node.id, { ...node, connections: [] });
  }

  const connect = (a: string, b: string) => {
    graph.get(a)!.connections.push(b);
    graph.get(b)!.connections.push(a);
  };

  // Horizontal main path
  connect("cross_left", "cross_center");
  connect("cross_center", "cross_right");
  connect("cross_right", "lounge_junction");

  // Vertical main path
  connect("cross_top", "cross_center");
  connect("cross_center", "cross_bottom");

  // Buildings to intersections
  connect("bld_newsroom", "cross_left");
  connect("bld_newsroom", "cross_top");
  connect("bld_workshop", "cross_left");
  connect("bld_workshop", "cross_bottom");
  connect("bld_exchange", "cross_right");
  connect("bld_exchange", "cross_top");
  connect("bld_pit", "cross_right");
  connect("bld_pit", "cross_bottom");
  connect("bld_lounge", "lounge_junction");

  return graph;
}

const GRAPH = buildGraph();

function distance(a: Waypoint, b: Waypoint): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function dijkstra(startId: string, endId: string): string[] {
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const visited = new Set<string>();

  for (const id of GRAPH.keys()) {
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

    const node = GRAPH.get(current)!;
    for (const neighborId of node.connections) {
      if (visited.has(neighborId)) continue;
      const neighbor = GRAPH.get(neighborId)!;
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

export function findPath(from: Building, to: Building): PathPoint[] {
  if (from === to) return [];

  const startId = `bld_${from}`;
  const endId = `bld_${to}`;
  const nodeIds = dijkstra(startId, endId);

  return nodeIds.slice(1).map((id) => {
    const node = GRAPH.get(id)!;
    return { x: node.x, y: node.y };
  });
}

export function getBuildingEntrance(building: Building): PathPoint {
  return BUILDING_ENTRANCES[building];
}

export function getPathSegments(): { from: PathPoint; to: PathPoint }[] {
  const segments: { from: PathPoint; to: PathPoint }[] = [];
  const seen = new Set<string>();

  for (const [id, node] of GRAPH) {
    for (const connId of node.connections) {
      const key = [id, connId].sort().join("-");
      if (seen.has(key)) continue;
      seen.add(key);
      const conn = GRAPH.get(connId)!;
      segments.push({
        from: { x: node.x, y: node.y },
        to: { x: conn.x, y: conn.y },
      });
    }
  }

  return segments;
}
