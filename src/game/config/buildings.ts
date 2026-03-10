import { Building } from "./agents";

export interface BuildingConfig {
  id: Building;
  name: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  roofColor: string;
  /** Where agents stand when "inside" this building */
  slots: { x: number; y: number }[];
}

// World is 1280x720 (canvas size)
// HUD takes ~180px left sidebar and ~230px right sidebar
// Safe play area is roughly x:200 to x:1040
// Buildings pushed inward to avoid HUD overlap
export const BUILDINGS: Record<Building, BuildingConfig> = {
  newsroom: {
    id: "newsroom",
    name: "The Newsroom",
    label: "📰 NEWSROOM",
    x: 200,
    y: 80,
    width: 180,
    height: 120,
    color: "#374151",
    roofColor: "#991b1b",
    slots: [
      { x: 245, y: 165 },
      { x: 290, y: 165 },
      { x: 335, y: 165 },
      { x: 268, y: 185 },
      { x: 312, y: 185 },
    ],
  },
  workshop: {
    id: "workshop",
    name: "The Workshop",
    label: "🔧 WORKSHOP",
    x: 200,
    y: 420,
    width: 180,
    height: 120,
    color: "#374151",
    roofColor: "#6b21a8",
    slots: [
      { x: 245, y: 505 },
      { x: 290, y: 505 },
      { x: 335, y: 505 },
      { x: 268, y: 525 },
      { x: 312, y: 525 },
    ],
  },
  exchange: {
    id: "exchange",
    name: "The Exchange",
    label: "📊 EXCHANGE",
    x: 530,
    y: 70,
    width: 200,
    height: 140,
    color: "#374151",
    roofColor: "#0e7490",
    slots: [
      { x: 575, y: 175 },
      { x: 625, y: 175 },
      { x: 675, y: 175 },
      { x: 600, y: 195 },
      { x: 650, y: 195 },
    ],
  },
  pit: {
    id: "pit",
    name: "The Trading Pit",
    label: "🔥 TRADING PIT",
    x: 530,
    y: 410,
    width: 200,
    height: 140,
    color: "#374151",
    roofColor: "#c2410c",
    slots: [
      { x: 575, y: 510 },
      { x: 625, y: 510 },
      { x: 675, y: 510 },
      { x: 600, y: 530 },
      { x: 650, y: 530 },
    ],
  },
  lounge: {
    id: "lounge",
    name: "The Lounge",
    label: "☕ LOUNGE",
    x: 830,
    y: 260,
    width: 180,
    height: 120,
    color: "#374151",
    roofColor: "#92400e",
    slots: [
      { x: 875, y: 345 },
      { x: 920, y: 345 },
      { x: 965, y: 345 },
      { x: 898, y: 365 },
      { x: 942, y: 365 },
    ],
  },
};

export const BUILDING_LIST = Object.values(BUILDINGS);
