import Phaser from "phaser";
import { ALL_AGENTS, type Building, type Emotion } from "../config/agents";
import { BUILDINGS, BUILDING_LIST, type BuildingConfig } from "../config/buildings";
import { Agent } from "../entities/Agent";
import { findPath, getPathSegments, getBuildingEntrance } from "../systems/Pathfinding";

export class TownScene extends Phaser.Scene {
  private agents = new Map<string, Agent>();
  private agentLocations = new Map<string, Building>();
  private buildingSlotOccupancy = new Map<string, Map<string, string>>();
  private marketDisplays: Phaser.GameObjects.Container[] = [];
  private newsAlertContainer?: Phaser.GameObjects.Container;

  constructor() {
    super({ key: "TownScene" });
  }

  create(): void {
    this.drawGround();
    this.drawPaths();
    this.drawTrees();
    this.drawBuildings();
    this.spawnAgents();
    this.addBuildingAnimations();
  }

  // ── Drawing ──────────────────────────────────────────────

  private drawGround(): void {
    const gfx = this.add.graphics();

    // Grass base
    gfx.fillStyle(0x2d5a27, 1);
    gfx.fillRect(0, 0, 1280, 720);

    // Subtle grass texture with darker patches
    gfx.fillStyle(0x245020, 0.4);
    for (let i = 0; i < 60; i++) {
      const x = Math.random() * 1280;
      const y = Math.random() * 720;
      gfx.fillRect(x, y, 8 + Math.random() * 16, 4 + Math.random() * 8);
    }

    // Lighter grass highlights
    gfx.fillStyle(0x3a7a33, 0.3);
    for (let i = 0; i < 40; i++) {
      const x = Math.random() * 1280;
      const y = Math.random() * 720;
      gfx.fillRect(x, y, 4 + Math.random() * 12, 4 + Math.random() * 6);
    }

    gfx.setDepth(0);
  }

  private drawPaths(): void {
    const gfx = this.add.graphics();
    const segments = getPathSegments();

    // Dirt base
    gfx.lineStyle(24, 0x8b7355, 1);
    for (const seg of segments) {
      gfx.lineBetween(seg.from.x, seg.from.y, seg.to.x, seg.to.y);
    }

    // Lighter center line
    gfx.lineStyle(16, 0xa08c6a, 1);
    for (const seg of segments) {
      gfx.lineBetween(seg.from.x, seg.from.y, seg.to.x, seg.to.y);
    }

    // Pebble texture
    gfx.fillStyle(0x9a8b70, 0.5);
    for (const seg of segments) {
      const dx = seg.to.x - seg.from.x;
      const dy = seg.to.y - seg.from.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.floor(dist / 12);
      for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const px = seg.from.x + dx * t + (Math.random() - 0.5) * 8;
        const py = seg.from.y + dy * t + (Math.random() - 0.5) * 8;
        gfx.fillRect(px, py, 2, 2);
      }
    }

    gfx.setDepth(1);
  }

  private drawTrees(): void {
    const gfx = this.add.graphics();
    gfx.setDepth(2);

    // Place trees in empty areas between buildings
    const treePositions = [
      { x: 440, y: 100 }, { x: 470, y: 150 },
      { x: 430, y: 500 }, { x: 470, y: 560 },
      { x: 780, y: 130 }, { x: 800, y: 170 },
      { x: 780, y: 500 }, { x: 810, y: 550 },
      { x: 1060, y: 200 }, { x: 1080, y: 460 },
      { x: 1050, y: 140 }, { x: 1070, y: 500 },
    ];

    for (const pos of treePositions) {
      this.drawTree(gfx, pos.x, pos.y);
    }

    // Bushes scattered around
    const bushPositions = [
      { x: 230, y: 310 }, { x: 500, y: 320 },
      { x: 750, y: 250 }, { x: 750, y: 420 },
      { x: 430, y: 240 }, { x: 430, y: 420 },
    ];

    for (const pos of bushPositions) {
      this.drawBush(gfx, pos.x, pos.y);
    }
  }

  private drawTree(gfx: Phaser.GameObjects.Graphics, x: number, y: number): void {
    // Trunk
    gfx.fillStyle(0x5c3d1e, 1);
    gfx.fillRect(x - 3, y, 6, 16);

    // Canopy (layered circles for pixel look)
    gfx.fillStyle(0x1a6b1a, 1);
    gfx.fillRect(x - 10, y - 8, 20, 12);
    gfx.fillStyle(0x228b22, 1);
    gfx.fillRect(x - 8, y - 12, 16, 10);
    gfx.fillStyle(0x2ea82e, 0.8);
    gfx.fillRect(x - 4, y - 14, 8, 6);
  }

  private drawBush(gfx: Phaser.GameObjects.Graphics, x: number, y: number): void {
    gfx.fillStyle(0x1e7a1e, 1);
    gfx.fillRoundedRect(x - 8, y - 4, 16, 10, 3);
    gfx.fillStyle(0x2a9a2a, 0.7);
    gfx.fillRoundedRect(x - 5, y - 6, 10, 6, 2);
  }

  private drawBuildings(): void {
    for (const building of BUILDING_LIST) {
      this.drawBuilding(building);
    }
  }

  private drawBuilding(config: BuildingConfig): void {
    const { x, y, width, height, color, roofColor, label } = config;
    const gfx = this.add.graphics();
    gfx.setDepth(10);

    const wallColor = Phaser.Display.Color.HexStringToColor(color).color;
    const roof = Phaser.Display.Color.HexStringToColor(roofColor).color;

    // Shadow
    gfx.fillStyle(0x000000, 0.2);
    gfx.fillRect(x + 4, y + 4, width, height);

    // Walls
    gfx.fillStyle(wallColor, 1);
    gfx.fillRect(x, y, width, height);

    // Wall border
    gfx.lineStyle(2, 0x1f2937, 1);
    gfx.strokeRect(x, y, width, height);

    // Roof
    gfx.fillStyle(roof, 1);
    gfx.fillRect(x - 4, y - 12, width + 8, 16);
    gfx.lineStyle(1, 0x111827, 0.6);
    gfx.strokeRect(x - 4, y - 12, width + 8, 16);

    // Windows (2x2 grid)
    gfx.fillStyle(0xfef08a, 0.7);
    const winStartX = x + 20;
    const winStartY = y + 20;
    const winSpacingX = (width - 40) / 3;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        gfx.fillRect(
          winStartX + col * winSpacingX,
          winStartY + row * 30,
          12,
          12
        );
      }
    }

    // Door (centered at bottom)
    const doorX = x + width / 2 - 8;
    const doorY = y + height - 20;
    gfx.fillStyle(0x78350f, 1);
    gfx.fillRect(doorX, doorY, 16, 20);
    // Doorknob
    gfx.fillStyle(0xfbbf24, 1);
    gfx.fillCircle(doorX + 12, doorY + 12, 2);

    // Label
    this.add
      .text(x + width / 2, y - 18, label, {
        fontSize: "11px",
        fontFamily: "monospace",
        color: "#f1f5f9",
        align: "center",
        stroke: "#0f172a",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(11);
  }

  private addBuildingAnimations(): void {
    // Blink random windows
    const windowGfx = this.add.graphics();
    windowGfx.setDepth(12);

    this.time.addEvent({
      delay: 2000,
      loop: true,
      callback: () => {
        windowGfx.clear();
        // Randomly brighten a couple windows across buildings
        for (const building of BUILDING_LIST) {
          if (Math.random() > 0.5) {
            const wx = building.x + 20 + Math.floor(Math.random() * 3) * ((building.width - 40) / 3);
            const wy = building.y + 20 + Math.floor(Math.random() * 2) * 30;
            windowGfx.fillStyle(0xfef9c3, 0.9);
            windowGfx.fillRect(wx, wy, 12, 12);
          }
        }
      },
    });
  }

  // ── Agent Management ─────────────────────────────────────

  private spawnAgents(): void {
    const lounge = BUILDINGS.lounge;

    // Initialize slot occupancy for all buildings
    for (const building of BUILDING_LIST) {
      this.buildingSlotOccupancy.set(building.id, new Map());
    }

    ALL_AGENTS.forEach((config, i) => {
      // Spread agents across lounge slots and nearby area
      const slotIdx = i % lounge.slots.length;
      const slot = lounge.slots[slotIdx];
      const offsetX = Math.floor(i / lounge.slots.length) * 20;
      const offsetY = Math.floor(i / lounge.slots.length) * 15;

      const agent = new Agent(this, config, slot.x + offsetX, slot.y + offsetY);
      this.agents.set(config.id, agent);
      this.agentLocations.set(config.id, "lounge");
    });
  }

  private assignSlot(agentId: string, building: Building): { x: number; y: number } {
    const config = BUILDINGS[building];
    const occupancy = this.buildingSlotOccupancy.get(building)!;

    // Find first open slot
    for (let i = 0; i < config.slots.length; i++) {
      let taken = false;
      for (const [, slotIdx] of occupancy) {
        if (slotIdx === i.toString()) {
          taken = true;
          break;
        }
      }
      if (!taken) {
        occupancy.set(agentId, i.toString());
        return config.slots[i];
      }
    }

    // Overflow: stack near building with offset
    const overflow = occupancy.size - config.slots.length;
    const entrance = getBuildingEntrance(building);
    occupancy.set(agentId, `overflow_${overflow}`);
    return {
      x: entrance.x + (overflow % 3) * 20 - 20,
      y: entrance.y + Math.floor(overflow / 3) * 15,
    };
  }

  private releaseSlot(agentId: string, building: Building): void {
    this.buildingSlotOccupancy.get(building)?.delete(agentId);
  }

  // ── Public API (called by EventProcessor or React) ──────

  moveAgent(agentId: string, destination: Building): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const currentBuilding = this.agentLocations.get(agentId) ?? "lounge";
    if (currentBuilding === destination) return;

    // Release old slot
    this.releaseSlot(agentId, currentBuilding);

    // Get path waypoints
    const pathPoints = findPath(currentBuilding, destination);

    // Assign slot at destination
    const finalSlot = this.assignSlot(agentId, destination);

    // Add final slot as last waypoint
    const fullPath = [...pathPoints, finalSlot];

    agent.walkTo(fullPath, () => {
      this.agentLocations.set(agentId, destination);
    });

    this.agentLocations.set(agentId, destination);
  }

  showSpeechBubble(agentId: string, text: string, emotion: Emotion): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.showSpeech(text, emotion);
  }

  showNewsAlert(headline: string, severity: "breaking" | "normal" = "breaking"): void {
    // Remove existing alert
    if (this.newsAlertContainer) {
      this.newsAlertContainer.destroy();
    }

    const container = this.add.container(640, -40);
    container.setDepth(2000);

    const bgColor = severity === "breaking" ? 0xdc2626 : 0x2563eb;
    const labelText = severity === "breaking" ? "BREAKING" : "NEWS";

    const bg = this.add.graphics();
    const textObj = this.add.text(0, 0, `${labelText}: ${headline}`, {
      fontSize: "13px",
      fontFamily: "monospace",
      color: "#ffffff",
      align: "center",
      wordWrap: { width: 600 },
      stroke: "#000000",
      strokeThickness: 1,
    });
    textObj.setOrigin(0.5, 0.5);

    const padding = 12;
    const w = textObj.width + padding * 2;
    const h = textObj.height + padding * 2;

    bg.fillStyle(bgColor, 0.95);
    bg.fillRoundedRect(-w / 2, -h / 2, w, h, 4);
    bg.lineStyle(2, 0xffffff, 0.3);
    bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 4);

    container.add(bg);
    container.add(textObj);
    this.newsAlertContainer = container;

    // Slide in — y:60 clears the HUD news ticker at top
    this.tweens.add({
      targets: container,
      y: 60,
      duration: 400,
      ease: "Back.easeOut",
    });

    // Slide out after 5s
    this.time.delayedCall(5000, () => {
      this.tweens.add({
        targets: container,
        y: -50,
        alpha: 0,
        duration: 400,
        ease: "Cubic.easeIn",
        onComplete: () => {
          container.destroy();
          if (this.newsAlertContainer === container) {
            this.newsAlertContainer = undefined;
          }
        },
      });
    });
  }

  showMarketOnExchange(question: string, price?: number): void {
    const MAX_VISIBLE = 3;
    const exchange = BUILDINGS.exchange;

    // Fade out oldest if at limit
    while (this.marketDisplays.length >= MAX_VISIBLE) {
      const old = this.marketDisplays.shift();
      if (old) {
        this.tweens.add({
          targets: old,
          alpha: 0,
          duration: 400,
          ease: "Linear",
          onComplete: () => old.destroy(),
        });
      }
    }

    // Reposition remaining displays
    for (let i = 0; i < this.marketDisplays.length; i++) {
      this.tweens.add({
        targets: this.marketDisplays[i],
        y: exchange.y + 20 + i * 28,
        duration: 200,
        ease: "Cubic.easeOut",
      });
    }

    const yOffset = this.marketDisplays.length * 28;
    const container = this.add.container(
      exchange.x + exchange.width + 16,
      exchange.y + 20 + yOffset
    );
    container.setDepth(15);
    container.setAlpha(0);

    // Truncate question for on-canvas display
    const shortQ = question.length > 50 ? question.slice(0, 47) + "..." : question;

    const bg = this.add.graphics();
    const label = this.add.text(8, 4, shortQ, {
      fontSize: "9px",
      fontFamily: "monospace",
      color: "#e2e8f0",
      wordWrap: { width: 200 },
    });

    const priceText = this.add.text(8, label.height + 8, price ? `${Math.round(price * 100)}c` : "Pricing...", {
      fontSize: "10px",
      fontFamily: "monospace",
      color: "#34d399",
      fontStyle: "bold",
    });

    const w = 220;
    const h = label.height + priceText.height + 16;

    bg.fillStyle(0x1e293b, 0.9);
    bg.fillRoundedRect(0, 0, w, h, 3);
    bg.lineStyle(1, 0x0e7490, 0.6);
    bg.strokeRoundedRect(0, 0, w, h, 3);

    container.add(bg);
    container.add(label);
    container.add(priceText);

    container.setData("question", question);
    this.marketDisplays.push(container);

    this.tweens.add({
      targets: container,
      alpha: 1,
      duration: 300,
      ease: "Linear",
    });
  }

  updateMarketPrice(marketId: string, fairValue: number, spread: number): void {
    // Update the price text on market displays
    for (const display of this.marketDisplays) {
      const children = display.getAll() as Phaser.GameObjects.GameObject[];
      // Last text child is the price
      const texts = children.filter(
        (c) => c instanceof Phaser.GameObjects.Text
      ) as Phaser.GameObjects.Text[];
      if (texts.length >= 2) {
        const priceText = texts[texts.length - 1];
        priceText.setText(`${Math.round(fairValue * 100)}c (spread: ${Math.round(spread * 100)}c)`);

        // Flash effect
        this.tweens.add({
          targets: priceText,
          scaleX: 1.2,
          scaleY: 1.2,
          duration: 100,
          yoyo: true,
          ease: "Cubic.easeOut",
        });
      }
    }
  }

  showTradeEffect(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.showTradeEffect();
  }

  // ── Idle behavior ────────────────────────────────────────

  getAgentIds(): string[] {
    return Array.from(this.agents.keys());
  }

  getRandomBuilding(): Building {
    const buildings: Building[] = ["newsroom", "workshop", "exchange", "pit", "lounge"];
    return buildings[Math.floor(Math.random() * buildings.length)];
  }
}
