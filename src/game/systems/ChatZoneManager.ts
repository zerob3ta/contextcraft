import Phaser from "phaser";
import type { Emotion } from "../config/agents";
import type { RealBuilding } from "../config/agents";
import type { CampusBuildingConfig } from "../config/campus-buildings";
import { CAMPUS_BUILDINGS } from "../config/campus-buildings";

const BUBBLE_PADDING_X = 10;
const BUBBLE_PADDING_Y = 6;
const BUBBLE_MAX_WIDTH = 300;
const BUBBLE_FONT_SIZE = 11;
const BUBBLE_LINE_HEIGHT = 14;
const BUBBLE_MAX_LINES = 4;
const BUBBLE_BORDER_RADIUS = 4;
const BUBBLE_GAP = 6;
const BUBBLE_FADE_DURATION = 400;
const BUBBLE_DISPLAY_DURATION = 8000; // longer than per-agent bubbles since these persist

const EMOTION_COLORS: Record<Emotion, number> = {
  excited: 0xfef08a,
  cautious: 0x93c5fd,
  neutral: 0xf1f5f9,
  frustrated: 0xfca5a5,
};

const EMOTION_TEXT_COLORS: Record<Emotion, string> = {
  excited: "#422006",
  cautious: "#1e3a5f",
  neutral: "#1e293b",
  frustrated: "#7f1d1d",
};

interface ZoneBubble {
  container: Phaser.GameObjects.Container;
  height: number;
  expireTimer: Phaser.Time.TimerEvent;
}

interface ChatZone {
  buildingId: RealBuilding;
  config: CampusBuildingConfig;
  bubbles: ZoneBubble[];
  /** X position of the chat zone anchor */
  anchorX: number;
  /** Y position of the chat zone bottom (bubbles stack upward) */
  anchorY: number;
}

export class ChatZoneManager {
  private scene: Phaser.Scene;
  private zones = new Map<RealBuilding, ChatZone>();

  constructor(scene: Phaser.Scene) {
    this.scene = scene;

    // Initialize zones for each building
    for (const [id, config] of Object.entries(CAMPUS_BUILDINGS)) {
      const buildingId = id as RealBuilding;
      const chatZone = config.chatZone;

      let anchorX: number;
      if (chatZone.side === "right") {
        anchorX = config.x + config.width + chatZone.offsetX + chatZone.width / 2;
      } else {
        anchorX = config.x - chatZone.offsetX - chatZone.width / 2;
      }

      // Bottom of chat zone aligns with bottom of building
      const anchorY = config.y + config.height;

      this.zones.set(buildingId, {
        buildingId,
        config,
        bubbles: [],
        anchorX,
        anchorY,
      });
    }
  }

  /**
   * Show a chat bubble in a building's chat zone.
   * Stacks bottom-up; oldest fade out when maxBubbles exceeded.
   */
  showBubble(
    buildingId: RealBuilding,
    agentName: string,
    text: string,
    emotion: Emotion,
    agentColor: string
  ): void {
    const zone = this.zones.get(buildingId);
    if (!zone) return;

    const maxBubbles = zone.config.chatZone.maxBubbles;

    // Evict oldest if at capacity
    while (zone.bubbles.length >= maxBubbles) {
      const oldest = zone.bubbles.shift();
      if (oldest) {
        oldest.expireTimer.destroy();
        this.fadeOutBubble(oldest.container);
      }
    }

    // Create the bubble
    const container = this.createBubble(zone, agentName, text, emotion, agentColor);
    const bounds = container.getBounds();
    const bubbleHeight = bounds.height;

    // Set up auto-expire
    const expireTimer = this.scene.time.delayedCall(BUBBLE_DISPLAY_DURATION, () => {
      const idx = zone.bubbles.findIndex((b) => b.container === container);
      if (idx !== -1) {
        zone.bubbles.splice(idx, 1);
        this.fadeOutBubble(container);
        this.repositionZone(zone);
      }
    });

    zone.bubbles.push({ container, height: bubbleHeight, expireTimer });

    // Fade in
    container.setAlpha(0);
    this.scene.tweens.add({
      targets: container,
      alpha: 1,
      duration: 150,
      ease: "Linear",
    });

    // Reposition all bubbles in zone
    this.repositionZone(zone);
  }

  private createBubble(
    zone: ChatZone,
    agentName: string,
    text: string,
    emotion: Emotion,
    agentColor: string
  ): Phaser.GameObjects.Container {
    const container = this.scene.add.container(zone.anchorX, zone.anchorY);
    container.setDepth(1000);

    // Agent name label
    const nameLabel = this.scene.add.text(
      -BUBBLE_MAX_WIDTH / 2 + BUBBLE_PADDING_X,
      0,
      agentName,
      {
        fontSize: "10px",
        fontFamily: "monospace",
        color: agentColor,
        fontStyle: "bold",
      }
    );

    // Message text
    const msgLabel = this.scene.add.text(
      -BUBBLE_MAX_WIDTH / 2 + BUBBLE_PADDING_X,
      nameLabel.height + 2,
      text,
      {
        fontSize: `${BUBBLE_FONT_SIZE}px`,
        fontFamily: "monospace",
        color: EMOTION_TEXT_COLORS[emotion],
        wordWrap: { width: BUBBLE_MAX_WIDTH - BUBBLE_PADDING_X * 2 },
        lineSpacing: 2,
      }
    );

    // Clamp lines
    const maxHeight = BUBBLE_MAX_LINES * BUBBLE_LINE_HEIGHT;
    if (msgLabel.height > maxHeight) {
      const words = msgLabel.text.split(" ");
      while (words.length > 1) {
        words.pop();
        msgLabel.setText(words.join(" ") + "...");
        if (msgLabel.height <= maxHeight) break;
      }
    }

    const totalH = nameLabel.height + 2 + msgLabel.height + BUBBLE_PADDING_Y * 2;
    const totalW = BUBBLE_MAX_WIDTH;

    // Background
    const bg = this.scene.add.graphics();
    const bgColor = EMOTION_COLORS[emotion];
    bg.fillStyle(bgColor, 0.95);
    bg.fillRoundedRect(-totalW / 2, 0, totalW, totalH, BUBBLE_BORDER_RADIUS);
    bg.lineStyle(1, 0x475569, 0.4);
    bg.strokeRoundedRect(-totalW / 2, 0, totalW, totalH, BUBBLE_BORDER_RADIUS);

    // Agent color accent bar
    const accentColor = Phaser.Display.Color.HexStringToColor(agentColor).color;
    bg.fillStyle(accentColor, 0.9);
    bg.fillRoundedRect(-totalW / 2, 0, 3, totalH, {
      tl: BUBBLE_BORDER_RADIUS,
      bl: BUBBLE_BORDER_RADIUS,
      tr: 0,
      br: 0,
    });

    // Position text within padding
    nameLabel.setPosition(-totalW / 2 + BUBBLE_PADDING_X, BUBBLE_PADDING_Y);
    msgLabel.setPosition(
      -totalW / 2 + BUBBLE_PADDING_X,
      BUBBLE_PADDING_Y + nameLabel.height + 2
    );

    container.add(bg);
    container.add(nameLabel);
    container.add(msgLabel);

    return container;
  }

  /** Reposition bubbles in a zone: newest at bottom, stack upward */
  private repositionZone(zone: ChatZone): void {
    let offsetY = 0;
    // Newest bubble at bottom (end of array), stack upward
    for (let i = zone.bubbles.length - 1; i >= 0; i--) {
      const bubble = zone.bubbles[i];
      const targetY = zone.anchorY - offsetY - bubble.height;

      this.scene.tweens.add({
        targets: bubble.container,
        y: targetY,
        duration: 200,
        ease: "Cubic.easeOut",
      });

      offsetY += bubble.height + BUBBLE_GAP;
    }
  }

  private fadeOutBubble(container: Phaser.GameObjects.Container): void {
    if (!this.scene) return;
    this.scene.tweens.add({
      targets: container,
      alpha: 0,
      duration: BUBBLE_FADE_DURATION,
      ease: "Linear",
      onComplete: () => container.destroy(),
    });
  }

  destroy(): void {
    for (const zone of this.zones.values()) {
      for (const bubble of zone.bubbles) {
        bubble.expireTimer.destroy();
        bubble.container.destroy();
      }
      zone.bubbles = [];
    }
  }
}
