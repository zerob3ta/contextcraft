import Phaser from "phaser";
import type { RealBuilding } from "../config/agents";
import { CAMPUS_BUILDINGS } from "../config/campus-buildings";

export type CameraMode =
  | { type: "idle" }
  | { type: "building"; buildingId: RealBuilding }
  | { type: "agent"; agentId: string };

const LERP_SPEED = 0.04;
const IDLE_DRIFT_INTERVAL = 8000;
const BUILDING_ZOOM = 1.4;
const AGENT_ZOOM = 1.6;
const IDLE_ZOOM = 1.0;

export class CameraController {
  private scene: Phaser.Scene;
  private mode: CameraMode = { type: "idle" };
  private targetX = 0;
  private targetY = 0;
  private targetZoom = IDLE_ZOOM;
  private idleDriftTimer?: Phaser.Time.TimerEvent;
  private getAgentPosition?: (agentId: string) => { x: number; y: number } | null;
  private lastActivityBuilding: RealBuilding = "lounge";

  constructor(
    scene: Phaser.Scene,
    getAgentPosition: (agentId: string) => { x: number; y: number } | null
  ) {
    this.scene = scene;
    this.getAgentPosition = getAgentPosition;

    // Start in idle, drifting to lounge
    const lounge = CAMPUS_BUILDINGS.lounge;
    this.targetX = lounge.x + lounge.width / 2;
    this.targetY = lounge.y + lounge.height / 2;
    this.targetZoom = IDLE_ZOOM;

    this.startIdleDrift();
  }

  getMode(): CameraMode {
    return this.mode;
  }

  /** Switch to idle mode — camera drifts to activity */
  setIdle(): void {
    this.mode = { type: "idle" };
    this.targetZoom = IDLE_ZOOM;
    this.startIdleDrift();
  }

  /** Lock camera on a building */
  focusBuilding(buildingId: RealBuilding): void {
    this.stopIdleDrift();
    this.mode = { type: "building", buildingId };
    const b = CAMPUS_BUILDINGS[buildingId];
    this.targetX = b.x + b.width / 2;
    this.targetY = b.y + b.height / 2;
    this.targetZoom = BUILDING_ZOOM;
  }

  /** Follow a specific agent */
  followAgent(agentId: string): void {
    this.stopIdleDrift();
    this.mode = { type: "agent", agentId };
    this.targetZoom = AGENT_ZOOM;
    // Position will update each frame in update()
  }

  /** Notify the camera that activity happened at a building (for idle drift) */
  notifyActivity(buildingId: RealBuilding): void {
    this.lastActivityBuilding = buildingId;
    // In idle mode, drift toward activity immediately
    if (this.mode.type === "idle") {
      const b = CAMPUS_BUILDINGS[buildingId];
      this.targetX = b.x + b.width / 2;
      this.targetY = b.y + b.height / 2;
    }
  }

  /** Called every frame to lerp camera toward target */
  update(): void {
    const cam = this.scene.cameras.main;

    // In agent follow mode, track agent position
    if (this.mode.type === "agent" && this.getAgentPosition) {
      const pos = this.getAgentPosition(this.mode.agentId);
      if (pos) {
        this.targetX = pos.x;
        this.targetY = pos.y;
      } else {
        // Agent gone — fall back to idle
        this.setIdle();
        return;
      }
    }

    // Smooth lerp toward target
    const cx = cam.scrollX + cam.width / (2 * cam.zoom);
    const cy = cam.scrollY + cam.height / (2 * cam.zoom);

    const newX = cx + (this.targetX - cx) * LERP_SPEED;
    const newY = cy + (this.targetY - cy) * LERP_SPEED;
    cam.centerOn(newX, newY);

    // Smooth zoom
    cam.zoom += (this.targetZoom - cam.zoom) * LERP_SPEED;
  }

  private startIdleDrift(): void {
    this.stopIdleDrift();
    this.idleDriftTimer = this.scene.time.addEvent({
      delay: IDLE_DRIFT_INTERVAL,
      loop: true,
      callback: () => {
        if (this.mode.type !== "idle") return;
        // Drift to last activity building
        const b = CAMPUS_BUILDINGS[this.lastActivityBuilding];
        this.targetX = b.x + b.width / 2;
        this.targetY = b.y + b.height / 2;
      },
    });
  }

  private stopIdleDrift(): void {
    this.idleDriftTimer?.destroy();
    this.idleDriftTimer = undefined;
  }

  destroy(): void {
    this.stopIdleDrift();
  }
}
