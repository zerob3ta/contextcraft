import type { RealBuilding } from "./agents";

export interface BuildingConfig {
  id: RealBuilding;
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

// Canvas fills center area (no HUD overlay). Full space available.
// Buildings spread across ~1100x750 with generous spacing.
export const BUILDINGS: Record<RealBuilding, BuildingConfig> = {
  newsroom: {
    id: "newsroom",
    name: "The Newsroom",
    label: "📰 NEWSROOM",
    x: 80,
    y: 80,
    width: 190,
    height: 130,
    color: "#374151",
    roofColor: "#991b1b",
    slots: [
      { x: 125, y: 175 },
      { x: 175, y: 175 },
      { x: 225, y: 175 },
      { x: 150, y: 195 },
      { x: 200, y: 195 },
    ],
  },
  workshop: {
    id: "workshop",
    name: "The Workshop",
    label: "🔧 WORKSHOP",
    x: 80,
    y: 520,
    width: 190,
    height: 130,
    color: "#374151",
    roofColor: "#6b21a8",
    slots: [
      { x: 125, y: 615 },
      { x: 175, y: 615 },
      { x: 225, y: 615 },
      { x: 150, y: 635 },
      { x: 200, y: 635 },
    ],
  },
  exchange: {
    id: "exchange",
    name: "The Exchange",
    label: "📊 EXCHANGE",
    x: 440,
    y: 60,
    width: 210,
    height: 150,
    color: "#374151",
    roofColor: "#0e7490",
    slots: [
      { x: 490, y: 175 },
      { x: 545, y: 175 },
      { x: 600, y: 175 },
      { x: 518, y: 195 },
      { x: 572, y: 195 },
    ],
  },
  pit: {
    id: "pit",
    name: "The Trading Pit",
    label: "🔥 TRADING PIT",
    x: 440,
    y: 510,
    width: 210,
    height: 150,
    color: "#374151",
    roofColor: "#c2410c",
    slots: [
      { x: 490, y: 625 },
      { x: 545, y: 625 },
      { x: 600, y: 625 },
      { x: 518, y: 645 },
      { x: 572, y: 645 },
    ],
  },
  lounge: {
    id: "lounge",
    name: "The Lounge",
    label: "☕ LOUNGE",
    x: 790,
    y: 290,
    width: 200,
    height: 140,
    color: "#374151",
    roofColor: "#92400e",
    slots: [
      { x: 840, y: 395 },
      { x: 890, y: 395 },
      { x: 940, y: 395 },
      { x: 865, y: 415 },
      { x: 915, y: 415 },
    ],
  },
};

export const BUILDING_LIST = Object.values(BUILDINGS);
