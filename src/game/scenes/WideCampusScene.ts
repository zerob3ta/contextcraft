import Phaser from "phaser";
import {
  ALL_AGENTS,
  type Building,
  type RealBuilding,
  type Emotion,
  type AgentConfig,
} from "../config/agents";
import type { AgentMood } from "../config/events";
import {
  CAMPUS_BUILDINGS,
  CAMPUS_BUILDING_LIST,
  CAMPUS_WORLD,
  type CampusBuildingConfig,
} from "../config/campus-buildings";
import { Agent } from "../entities/Agent";
import {
  findCampusPath,
  getCampusPathSegments,
  getCampusBuildingEntrance,
} from "../systems/CampusPathfinding";
import { CameraController } from "../systems/CameraController";
import { ChatZoneManager } from "../systems/ChatZoneManager";
import { DayNightWeather } from "../systems/DayNightWeather";

/**
 * Wide Campus scene — experiment for spread-out buildings with
 * on-canvas chat zones, camera-follows-action, and tap-to-follow-agent.
 *
 * Same public API as TownScene so EventProcessor can drive either.
 */
export class WideCampusScene extends Phaser.Scene {
  private agents = new Map<string, Agent>();
  private agentLocations = new Map<string, Building>();
  private buildingSlotOccupancy = new Map<string, Map<string, string>>();
  private marketDisplays: Phaser.GameObjects.Container[] = [];
  private newsAlertContainer?: Phaser.GameObjects.Container;
  private buildingSelectHandler?: (buildingId: string) => void;
  private selectedBuildingHighlight?: Phaser.GameObjects.Graphics;
  private dayNight!: DayNightWeather;
  private windowGfx?: Phaser.GameObjects.Graphics;
  private cameraCtrl!: CameraController;
  private chatZones!: ChatZoneManager;
  private chattingTimers = new Map<string, Phaser.Time.TimerEvent>();

  constructor() {
    super({ key: "WideCampusScene" });
  }

  create(): void {
    this.drawGround();
    this.drawPaths();
    this.drawTrees();
    this.drawBuildings();
    this.spawnAgents();
    this.addBuildingAnimations();
    this.setupCamera();
    this.dayNight = new DayNightWeather(this);
    this.chatZones = new ChatZoneManager(this);
    this.cameraCtrl = new CameraController(this, (agentId) => {
      const agent = this.agents.get(agentId);
      return agent ? { x: agent.x, y: agent.y } : null;
    });
  }

  // ── Camera ────────────────────────────────────────────────

  private setupCamera(): void {
    const cam = this.cameras.main;
    cam.setBounds(
      -50,
      -60,
      CAMPUS_WORLD.width + 100,
      CAMPUS_WORLD.height + 120
    );
    cam.centerOn(CAMPUS_WORLD.width / 2, CAMPUS_WORLD.height / 2);

    // Scroll-wheel zoom
    this.input.on(
      "wheel",
      (
        _pointer: Phaser.Input.Pointer,
        _go: unknown[],
        _dx: number,
        dy: number
      ) => {
        const newZoom = cam.zoom - dy * 0.001;
        cam.zoom = Phaser.Math.Clamp(newZoom, 0.5, 2.5);
      }
    );

    // Drag-to-pan (overrides camera controller when user drags)
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.downElement?.tagName === "CANVAS") {
        this._dragStart = {
          x: cam.scrollX,
          y: cam.scrollY,
          px: pointer.x,
          py: pointer.y,
        };
        // User interaction → go idle
        this.cameraCtrl?.setIdle();
      }
    });

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (!pointer.isDown || !this._dragStart) return;
      const zoom = cam.zoom;
      cam.scrollX =
        this._dragStart.x - (pointer.x - this._dragStart.px) / zoom;
      cam.scrollY =
        this._dragStart.y - (pointer.y - this._dragStart.py) / zoom;
    });

    this.input.on("pointerup", () => {
      this._dragStart = null;
    });

    // Pinch-to-zoom
    this.input.addPointer(1);

    this.input.on("pointerdown", () => {
      const pointers = this.input.manager.pointers.filter(
        (p: Phaser.Input.Pointer) => p.isDown
      );
      if (pointers.length === 2) {
        const [p1, p2] = pointers;
        this._pinchStartDist = Phaser.Math.Distance.Between(
          p1.x,
          p1.y,
          p2.x,
          p2.y
        );
        this._pinchStartZoom = cam.zoom;
      }
    });

    this.input.on("pointermove", () => {
      if (this._pinchStartDist === null) return;
      const pointers = this.input.manager.pointers.filter(
        (p: Phaser.Input.Pointer) => p.isDown
      );
      if (pointers.length < 2) return;
      const [p1, p2] = pointers;
      const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
      const scale = dist / this._pinchStartDist!;
      cam.zoom = Phaser.Math.Clamp(this._pinchStartZoom! * scale, 0.5, 2.5);
    });

    this.input.on("pointerup", () => {
      const pointers = this.input.manager.pointers.filter(
        (p: Phaser.Input.Pointer) => p.isDown
      );
      if (pointers.length < 2) {
        this._pinchStartDist = null;
        this._pinchStartZoom = null;
      }
    });
  }

  private _dragStart: {
    x: number;
    y: number;
    px: number;
    py: number;
  } | null = null;
  private _pinchStartDist: number | null = null;
  private _pinchStartZoom: number | null = null;

  // ── Drawing ────────────────────────────────────────────────

  private drawGround(): void {
    const gfx = this.add.graphics();
    const w = CAMPUS_WORLD.width + 100;
    const h = CAMPUS_WORLD.height + 120;

    gfx.fillStyle(0x2d5a27, 1);
    gfx.fillRect(-50, -60, w, h);

    gfx.fillStyle(0x245020, 0.4);
    for (let i = 0; i < 80; i++) {
      const x = -50 + Math.random() * w;
      const y = -60 + Math.random() * h;
      gfx.fillRect(x, y, 8 + Math.random() * 16, 4 + Math.random() * 8);
    }

    gfx.fillStyle(0x3a7a33, 0.3);
    for (let i = 0; i < 50; i++) {
      const x = -50 + Math.random() * w;
      const y = -60 + Math.random() * h;
      gfx.fillRect(x, y, 4 + Math.random() * 12, 4 + Math.random() * 6);
    }

    gfx.setDepth(0);
  }

  private drawPaths(): void {
    const gfx = this.add.graphics();
    const segments = getCampusPathSegments();

    gfx.lineStyle(24, 0x8b7355, 1);
    for (const seg of segments) {
      gfx.lineBetween(seg.from.x, seg.from.y, seg.to.x, seg.to.y);
    }

    gfx.lineStyle(16, 0xa08c6a, 1);
    for (const seg of segments) {
      gfx.lineBetween(seg.from.x, seg.from.y, seg.to.x, seg.to.y);
    }

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

    // Scatter trees around the campus
    const treePositions = [
      // Near newsroom
      { x: 50, y: 60 },
      { x: 370, y: 150 },
      // Between newsroom and exchange
      { x: 700, y: 80 },
      { x: 1000, y: 120 },
      { x: 1400, y: 90 },
      // Near exchange
      { x: 2100, y: 140 },
      { x: 2150, y: 300 },
      // Central area
      { x: 600, y: 500 },
      { x: 1400, y: 450 },
      { x: 700, y: 800 },
      { x: 1500, y: 780 },
      // Near pit
      { x: 50, y: 950 },
      { x: 380, y: 1100 },
      // Near workshop
      { x: 2100, y: 1000 },
      { x: 2150, y: 1200 },
      // Bottom edges
      { x: 600, y: 1200 },
      { x: 1400, y: 1250 },
    ];

    for (const pos of treePositions) {
      this.drawTree(gfx, pos.x, pos.y);
    }

    const bushPositions = [
      { x: 500, y: 300 },
      { x: 1300, y: 350 },
      { x: 800, y: 900 },
      { x: 1600, y: 850 },
      { x: 300, y: 700 },
      { x: 2000, y: 700 },
    ];

    for (const pos of bushPositions) {
      this.drawBush(gfx, pos.x, pos.y);
    }
  }

  private drawTree(
    gfx: Phaser.GameObjects.Graphics,
    x: number,
    y: number
  ): void {
    gfx.fillStyle(0x5c3d1e, 1);
    gfx.fillRect(x - 3, y, 6, 16);
    gfx.fillStyle(0x1a6b1a, 1);
    gfx.fillRect(x - 10, y - 8, 20, 12);
    gfx.fillStyle(0x228b22, 1);
    gfx.fillRect(x - 8, y - 12, 16, 10);
    gfx.fillStyle(0x2ea82e, 0.8);
    gfx.fillRect(x - 4, y - 14, 8, 6);
  }

  private drawBush(
    gfx: Phaser.GameObjects.Graphics,
    x: number,
    y: number
  ): void {
    gfx.fillStyle(0x1e7a1e, 1);
    gfx.fillRoundedRect(x - 8, y - 4, 16, 10, 3);
    gfx.fillStyle(0x2a9a2a, 0.7);
    gfx.fillRoundedRect(x - 5, y - 6, 10, 6, 2);
  }

  private drawBuildings(): void {
    for (const building of CAMPUS_BUILDING_LIST) {
      this.drawBuilding(building);
    }
  }

  private drawBuilding(config: CampusBuildingConfig): void {
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

    // Windows
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

    // Door
    const doorX = x + width / 2 - 8;
    const doorY = y + height - 20;
    gfx.fillStyle(0x78350f, 1);
    gfx.fillRect(doorX, doorY, 16, 20);
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

    // Clickable hit zone — building select + camera focus
    const hitZone = this.add.zone(
      x + width / 2,
      y + height / 2,
      width,
      height
    );
    hitZone.setInteractive({ useHandCursor: true });
    hitZone.setDepth(13);
    hitZone.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      // Prevent drag-to-pan from also triggering building focus
      pointer.event.stopPropagation();
      this.selectBuilding(config.id);
      this.cameraCtrl?.focusBuilding(config.id);
    });
  }

  private selectBuilding(buildingId: RealBuilding): void {
    if (this.selectedBuildingHighlight) {
      this.selectedBuildingHighlight.destroy();
    }
    const config = CAMPUS_BUILDINGS[buildingId];
    const gfx = this.add.graphics();
    gfx.setDepth(9);
    gfx.lineStyle(2, 0xffffff, 0.4);
    gfx.strokeRoundedRect(
      config.x - 3,
      config.y - 3,
      config.width + 6,
      config.height + 6,
      4
    );
    this.selectedBuildingHighlight = gfx;
    this.buildingSelectHandler?.(buildingId);
  }

  onBuildingSelect(handler: (buildingId: string) => void): void {
    this.buildingSelectHandler = handler;
  }

  private addBuildingAnimations(): void {
    this.windowGfx = this.add.graphics();
    this.windowGfx.setDepth(12);

    this.time.addEvent({
      delay: 2000,
      loop: true,
      callback: () => {
        if (!this.windowGfx) return;
        this.windowGfx.clear();

        const timeOfDay = this.dayNight?.getTimeOfDay() ?? "day";
        const glowChance =
          timeOfDay === "night"
            ? 0.85
            : timeOfDay === "dusk"
              ? 0.7
              : timeOfDay === "dawn"
                ? 0.6
                : 0.4;
        const glowAlpha = timeOfDay === "night" ? 1.0 : timeOfDay === "dusk" ? 0.9 : 0.7;
        const glowColor = timeOfDay === "night" ? 0xfef08a : 0xfef9c3;

        for (const building of CAMPUS_BUILDING_LIST) {
          const winStartX = building.x + 20;
          const winSpacingX = (building.width - 40) / 3;
          for (let row = 0; row < 2; row++) {
            for (let col = 0; col < 3; col++) {
              if (Math.random() < glowChance) {
                this.windowGfx.fillStyle(glowColor, glowAlpha);
                this.windowGfx.fillRect(
                  winStartX + col * winSpacingX,
                  building.y + 20 + row * 30,
                  12,
                  12
                );
              }
            }
          }
        }
      },
    });
  }

  // ── Agent Management ─────────────────────────────────────

  private spawnAgents(): void {
    for (const building of CAMPUS_BUILDING_LIST) {
      this.buildingSlotOccupancy.set(building.id, new Map());
    }
    for (const pathLoc of [
      "path_left",
      "path_center",
      "path_right",
    ] as Building[]) {
      this.buildingSlotOccupancy.set(pathLoc, new Map());
    }

    const roleBuildings: Record<string, RealBuilding> = {
      creator: "newsroom",
      pricer: "exchange",
      trader: "pit",
    };

    const spawnIdx: Record<string, number> = {};

    ALL_AGENTS.forEach((config) => {
      const building = roleBuildings[config.role] || "lounge";
      const bConfig = CAMPUS_BUILDINGS[building];
      const idx = spawnIdx[building] || 0;
      spawnIdx[building] = idx + 1;

      const slotIdx = idx % bConfig.slots.length;
      const slot = bConfig.slots[slotIdx];
      const row = Math.floor(idx / bConfig.slots.length);
      const offsetX = row * 18;
      const offsetY = row * 12;

      const agent = new Agent(
        this,
        config,
        slot.x + offsetX,
        slot.y + offsetY
      );

      // Tap agent → camera follows them
      agent.setInteractive(
        new Phaser.Geom.Rectangle(-16, -32, 32, 40),
        Phaser.Geom.Rectangle.Contains
      );
      agent.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        pointer.event.stopPropagation();
        this.cameraCtrl?.followAgent(config.id);
      });

      this.agents.set(config.id, agent);
      this.agentLocations.set(config.id, building);
    });
  }

  private isPathLocation(building: Building): boolean {
    return (
      building === "path_left" ||
      building === "path_center" ||
      building === "path_right"
    );
  }

  private assignSlot(
    agentId: string,
    building: Building
  ): { x: number; y: number } {
    if (this.isPathLocation(building)) {
      const entrance = getCampusBuildingEntrance(building);
      const occupancy = this.buildingSlotOccupancy.get(building);
      const idx = occupancy?.size || 0;
      occupancy?.set(agentId, idx.toString());
      return {
        x: entrance.x + (idx % 2 === 0 ? -15 : 15),
        y: entrance.y + (idx < 2 ? 0 : 15),
      };
    }

    const config = CAMPUS_BUILDINGS[building as RealBuilding];
    const occupancy = this.buildingSlotOccupancy.get(building)!;

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

    const overflow = occupancy.size - config.slots.length;
    const entrance = getCampusBuildingEntrance(building);
    occupancy.set(agentId, `overflow_${overflow}`);
    return {
      x: entrance.x + (overflow % 3) * 20 - 20,
      y: entrance.y + Math.floor(overflow / 3) * 15,
    };
  }

  private releaseSlot(agentId: string, building: Building): void {
    this.buildingSlotOccupancy.get(building)?.delete(agentId);
  }

  // ── Public API (same interface as TownScene) ──────────────

  moveAgent(agentId: string, destination: Building): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const currentBuilding = this.agentLocations.get(agentId) ?? "lounge";
    if (currentBuilding === destination) return;

    this.releaseSlot(agentId, currentBuilding);

    const pathPoints = findCampusPath(currentBuilding, destination);
    const finalSlot = this.assignSlot(agentId, destination);
    const fullPath = [...pathPoints, finalSlot];

    agent.walkTo(fullPath, () => {
      if (!this.agents.has(agentId)) return;
      this.agentLocations.set(agentId, destination);
      if (
        destination !== "lounge" &&
        !destination.startsWith("path_")
      ) {
        agent.setAgentState("working");
      } else {
        agent.setAgentState("idle");
      }
    });

    // Notify camera of activity at destination
    if (!this.isPathLocation(destination)) {
      this.cameraCtrl?.notifyActivity(destination as RealBuilding);
    }
  }

  showSpeechBubble(agentId: string, text: string, emotion: Emotion): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Show bubble on agent (existing per-agent bubble)
    agent.showSpeech(text, emotion);

    // Also show in building chat zone
    const building = this.agentLocations.get(agentId);
    if (building && !this.isPathLocation(building)) {
      this.chatZones?.showBubble(
        building as RealBuilding,
        agent.config.name,
        text,
        emotion,
        agent.config.color
      );
    }
  }

  getAgent(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  showNewsAlert(
    headline: string,
    severity: "breaking" | "normal" = "breaking"
  ): void {
    if (this.newsAlertContainer) {
      this.newsAlertContainer.destroy();
    }

    // Use scrollFactor 0 so it stays fixed on screen
    const cam = this.cameras.main;
    const container = this.add.container(0, 0);
    container.setDepth(2000);
    container.setScrollFactor(0);

    const bgColor = severity === "breaking" ? 0xdc2626 : 0x2563eb;
    const labelText = severity === "breaking" ? "BREAKING" : "NEWS";

    const bg = this.add.graphics();
    bg.setScrollFactor(0);
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
    textObj.setScrollFactor(0);

    const padding = 12;
    const w = textObj.width + padding * 2;
    const h = textObj.height + padding * 2;

    bg.fillStyle(bgColor, 0.95);
    bg.fillRoundedRect(-w / 2, -h / 2, w, h, 4);
    bg.lineStyle(2, 0xffffff, 0.3);
    bg.strokeRoundedRect(-w / 2, -h / 2, w, h, 4);

    container.add(bg);
    container.add(textObj);

    // Position in screen-space center top
    container.setPosition(cam.width / 2, -40);
    this.newsAlertContainer = container;

    this.tweens.add({
      targets: container,
      y: 60,
      duration: 400,
      ease: "Back.easeOut",
    });

    this.time.delayedCall(5000, () => {
      if (!this.tweens) return;
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
    const exchange = CAMPUS_BUILDINGS.exchange;

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

    const shortQ =
      question.length > 50 ? question.slice(0, 47) + "..." : question;

    const bg = this.add.graphics();
    const label = this.add.text(8, 4, shortQ, {
      fontSize: "9px",
      fontFamily: "monospace",
      color: "#e2e8f0",
      wordWrap: { width: 200 },
    });

    const priceText = this.add.text(
      8,
      label.height + 8,
      price ? `${Math.round(price * 100)}c` : "Pricing...",
      {
        fontSize: "10px",
        fontFamily: "monospace",
        color: "#34d399",
        fontStyle: "bold",
      }
    );

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

  updateMarketPrice(
    marketId: string,
    fairValue: number,
    spread: number
  ): void {
    for (const display of this.marketDisplays) {
      const children =
        display.getAll() as Phaser.GameObjects.GameObject[];
      const texts = children.filter(
        (c) => c instanceof Phaser.GameObjects.Text
      ) as Phaser.GameObjects.Text[];
      if (texts.length >= 2) {
        const priceText = texts[texts.length - 1];
        priceText.setText(
          `${Math.round(fairValue * 100)}c (spread: ${Math.round(spread * 100)}c)`
        );
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

  setAgentDirective(agentId: string, directive: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.setDirective(directive);
  }

  showDirectiveFulfilled(agentId: string, result: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.setDirective("");
    agent.setAgentState("idle");
    agent.showActionToast(result);
  }

  setAgentMood(agentId: string, mood: AgentMood): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.setMood(mood);
  }

  setAgentChatting(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.setAgentState("chatting");

    const existing = this.chattingTimers.get(agentId);
    if (existing) existing.destroy();

    this.chattingTimers.set(
      agentId,
      this.time.delayedCall(10000, () => {
        this.chattingTimers.delete(agentId);
        if (!this.agents.has(agentId)) return;
        if (agent.getAgentState() === "chatting") {
          agent.setAgentState("idle");
        }
      })
    );
  }

  // ── NPC Management ────────────────────────────────────────

  spawnNPC(config: AgentConfig): void {
    if (this.agents.has(config.id)) return;

    for (const [, existing] of this.agents) {
      if (
        existing.config.name === config.name &&
        existing.config.id.startsWith("npc_")
      ) {
        return;
      }
    }

    const startX = -40;
    const startY = 600 + Math.random() * 200;

    const agent = new Agent(this, config, startX, startY);

    // Tap to follow
    agent.setInteractive(
      new Phaser.Geom.Rectangle(-16, -32, 32, 40),
      Phaser.Geom.Rectangle.Contains
    );
    agent.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      pointer.event.stopPropagation();
      this.cameraCtrl?.followAgent(config.id);
    });

    this.agents.set(config.id, agent);
    this.agentLocations.set(config.id, "path_left");
    this.moveAgent(config.id, "lounge");
  }

  despawnNPC(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const currentBuilding = this.agentLocations.get(agentId) ?? "lounge";
    this.releaseSlot(agentId, currentBuilding);

    const chattingTimer = this.chattingTimers.get(agentId);
    if (chattingTimer) {
      chattingTimer.destroy();
      this.chattingTimers.delete(agentId);
    }

    const exitX = CAMPUS_WORLD.width + 50;
    const exitY = 600 + Math.random() * 200;

    agent.walkTo([{ x: exitX, y: exitY }], () => {
      if (!this.agents.has(agentId)) return;
      agent.destroy();
      this.agents.delete(agentId);
      this.agentLocations.delete(agentId);
    });
  }

  // ── Helpers ────────────────────────────────────────────────

  getAgentIds(): string[] {
    return Array.from(this.agents.keys());
  }

  getRandomBuilding(): Building {
    const buildings: Building[] = [
      "newsroom",
      "workshop",
      "exchange",
      "pit",
      "lounge",
    ];
    return buildings[Math.floor(Math.random() * buildings.length)];
  }

  update(): void {
    this.cameraCtrl?.update();
  }
}
