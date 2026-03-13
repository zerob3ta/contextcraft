import type { RealBuilding } from "./agents";
import type { BuildingConfig } from "./buildings";

/** Chat zone config for building-anchored speech bubbles */
export interface ChatZoneConfig {
  /** Which side of the building the chat zone sits on */
  side: "left" | "right";
  /** Horizontal offset from building edge */
  offsetX: number;
  /** Width of the chat zone */
  width: number;
  /** Max visible bubbles before oldest fades */
  maxBubbles: number;
}

export interface CampusBuildingConfig extends BuildingConfig {
  chatZone: ChatZoneConfig;
}

// Wide campus: ~2400x1400 world, 1280x900 viewport
// Buildings spread out with generous chat yards beside each
export const CAMPUS_WORLD = { width: 2400, height: 1400 };

export const CAMPUS_BUILDINGS: Record<RealBuilding, CampusBuildingConfig> = {
  newsroom: {
    id: "newsroom",
    name: "The Newsroom",
    label: "📰 NEWSROOM",
    x: 120,
    y: 100,
    width: 200,
    height: 140,
    color: "#374151",
    roofColor: "#991b1b",
    slots: [
      { x: 170, y: 210 },
      { x: 220, y: 210 },
      { x: 270, y: 210 },
      { x: 195, y: 230 },
      { x: 245, y: 230 },
    ],
    chatZone: {
      side: "right",
      offsetX: 30,
      width: 320,
      maxBubbles: 4,
    },
  },
  exchange: {
    id: "exchange",
    name: "The Exchange",
    label: "📊 EXCHANGE",
    x: 1800,
    y: 100,
    width: 220,
    height: 150,
    color: "#374151",
    roofColor: "#0e7490",
    slots: [
      { x: 1850, y: 220 },
      { x: 1910, y: 220 },
      { x: 1970, y: 220 },
      { x: 1880, y: 240 },
      { x: 1940, y: 240 },
    ],
    chatZone: {
      side: "left",
      offsetX: 30,
      width: 320,
      maxBubbles: 4,
    },
  },
  lounge: {
    id: "lounge",
    name: "The Lounge",
    label: "☕ LOUNGE",
    x: 900,
    y: 500,
    width: 240,
    height: 170,
    color: "#374151",
    roofColor: "#92400e",
    slots: [
      { x: 960, y: 640 },
      { x: 1020, y: 640 },
      { x: 1080, y: 640 },
      { x: 990, y: 660 },
      { x: 1050, y: 660 },
    ],
    chatZone: {
      side: "right",
      offsetX: 40,
      width: 380,
      maxBubbles: 6,
    },
  },
  pit: {
    id: "pit",
    name: "The Trading Pit",
    label: "🔥 TRADING PIT",
    x: 120,
    y: 1000,
    width: 210,
    height: 150,
    color: "#374151",
    roofColor: "#c2410c",
    slots: [
      { x: 170, y: 1120 },
      { x: 230, y: 1120 },
      { x: 280, y: 1120 },
      { x: 200, y: 1140 },
      { x: 260, y: 1140 },
    ],
    chatZone: {
      side: "right",
      offsetX: 30,
      width: 320,
      maxBubbles: 4,
    },
  },
  workshop: {
    id: "workshop",
    name: "The Workshop",
    label: "🔧 WORKSHOP",
    x: 1800,
    y: 1050,
    width: 200,
    height: 140,
    color: "#374151",
    roofColor: "#6b21a8",
    slots: [
      { x: 1850, y: 1160 },
      { x: 1900, y: 1160 },
      { x: 1950, y: 1160 },
      { x: 1875, y: 1180 },
      { x: 1925, y: 1180 },
    ],
    chatZone: {
      side: "left",
      offsetX: 30,
      width: 320,
      maxBubbles: 4,
    },
  },
};

export const CAMPUS_BUILDING_LIST = Object.values(CAMPUS_BUILDINGS);

/** Central crossroads where all paths converge */
export const CAMPUS_CROSSROADS = { x: 1100, y: 650 };
