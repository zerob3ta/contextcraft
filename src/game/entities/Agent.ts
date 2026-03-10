import Phaser from "phaser";
import type { AgentConfig, Emotion } from "../config/agents";
import { SpeechBubbleManager } from "./SpeechBubble";

// Scale factor: 1 "pixel" in our sprite = this many canvas pixels
const PX = 2;

// Height map per size variant (in sprite-pixels)
const HEIGHT_MAP: Record<string, number> = {
  small: 14,
  medium: 16,
  large: 18,
};

export class Agent extends Phaser.GameObjects.Container {
  public agentId: string;
  public config: AgentConfig;

  private sprite: Phaser.GameObjects.Graphics;
  private nameLabel: Phaser.GameObjects.Text;
  private bubbleManager: SpeechBubbleManager;
  private idleTween?: Phaser.Tweens.Tween;
  private walkTween?: Phaser.Tweens.Tween;
  private spriteHeight: number;
  private isMoving = false;
  private baseY = 0;

  constructor(scene: Phaser.Scene, config: AgentConfig, x: number, y: number) {
    super(scene, x, y);
    this.agentId = config.id;
    this.config = config;
    this.spriteHeight = (HEIGHT_MAP[config.spriteFeatures.size] ?? 16) * PX;
    this.baseY = y;

    this.sprite = scene.add.graphics();
    this.drawCharacter();
    this.add(this.sprite);

    this.nameLabel = scene.add
      .text(0, this.spriteHeight / 2 + 2, config.name, {
        fontSize: "8px",
        fontFamily: "monospace",
        color: "#e2e8f0",
        align: "center",
        stroke: "#0f172a",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 0);
    this.add(this.nameLabel);

    this.setDepth(100);
    scene.add.existing(this);

    this.bubbleManager = new SpeechBubbleManager(scene);
    this.startIdle();
  }

  /** Draw a pixel-art humanoid character */
  private drawCharacter(): void {
    const g = this.sprite;
    const color = Phaser.Display.Color.HexStringToColor(this.config.color).color;
    const accent = Phaser.Display.Color.HexStringToColor(this.config.accentColor).color;
    const features = this.config.spriteFeatures;
    const tall = features.size === "large";
    const small = features.size === "small";

    g.clear();

    // All coordinates in "sprite pixels" then multiplied by PX
    // Origin is center-bottom of the character

    // Skin tone (slightly warm)
    const skin = 0xf5d0a9;
    const skinShadow = 0xd4a574;

    // ── Head (5x5 sprite-px) ──
    const headW = 5;
    const headH = 5;
    const headY = tall ? -18 : small ? -13 : -16;

    // Head base
    this.px(g, skin, -2, headY, headW, headH);
    // Hair on top (2px tall)
    this.px(g, accent, -2, headY - 1, headW, 2);

    // Eyes
    this.px(g, 0xffffff, -1, headY + 2, 2, 1);
    this.px(g, 0xffffff, 1, headY + 2, 2, 1);
    this.px(g, 0x1e293b, 0, headY + 2, 1, 1);
    this.px(g, 0x1e293b, 2, headY + 2, 1, 1);

    // Mouth
    this.px(g, skinShadow, 0, headY + 4, 2, 1);

    // ── Hat / Hair accessory ──
    if (features.hat === "beret") {
      this.px(g, accent, -3, headY - 2, 7, 2);
      this.px(g, accent, -2, headY - 3, 3, 1);
    } else if (features.hat === "hood") {
      this.px(g, accent, -3, headY - 1, 8, 3);
      this.px(g, accent, -3, headY + 1, 1, 3);
      this.px(g, accent, 4, headY + 1, 1, 3);
    } else if (features.hat === "headband") {
      this.px(g, accent, -3, headY + 1, 8, 1);
    } else if (features.hairStyle === "spiky") {
      // Spikes going up
      this.px(g, accent, -2, headY - 3, 1, 2);
      this.px(g, accent, 0, headY - 4, 1, 3);
      this.px(g, accent, 2, headY - 3, 1, 2);
      this.px(g, accent, 4, headY - 2, 1, 1);
    } else if (features.hairStyle === "slicked") {
      this.px(g, accent, -2, headY - 1, headW + 1, 2);
      this.px(g, accent, 3, headY, 1, 3);
    }

    // Glasses
    if (features.glasses) {
      this.px(g, 0x475569, -2, headY + 2, 3, 1);
      this.px(g, 0x475569, 1, headY + 2, 3, 1);
      // Bridge
      this.px(g, 0x475569, 0, headY + 2, 2, 1);
      // Lens shine
      this.px(g, 0x94a3b8, -1, headY + 2, 1, 1);
      this.px(g, 0x94a3b8, 2, headY + 2, 1, 1);
    }

    // ── Body / Torso (5x wide, 4-6 tall) ──
    const torsoH = tall ? 6 : small ? 4 : 5;
    const torsoY = headY + headH;

    // Shirt (main color)
    this.px(g, color, -2, torsoY, 6, torsoH);
    // Darker sides for depth
    this.px(g, accent, -2, torsoY, 1, torsoH);
    this.px(g, accent, 3, torsoY, 1, torsoH);

    // Collar / neckline
    this.px(g, skin, 0, torsoY, 2, 1);

    // ── Arms (1px wide, hanging at sides) ──
    const armLen = torsoH - 1;
    this.px(g, skin, -3, torsoY + 1, 1, armLen);
    this.px(g, skin, 4, torsoY + 1, 1, armLen);

    // ── Legs (2px each, 3-4 tall) ──
    const legH = tall ? 4 : small ? 3 : 3;
    const legY = torsoY + torsoH;

    // Left leg
    this.px(g, accent, -1, legY, 2, legH);
    // Right leg
    this.px(g, accent, 1, legY, 2, legH);
    // Gap between legs
    this.px(g, 0x000000, 0, legY, 1, legH - 1);
    // Set alpha to 0 for the gap - actually just don't draw it, use clearRect approach
    // Shoes
    this.px(g, 0x3f3f46, -2, legY + legH, 2, 1);
    this.px(g, 0x3f3f46, 1, legY + legH, 2, 1);

    // ── Shadow on ground ──
    g.fillStyle(0x000000, 0.15);
    const shadowY = (legY + legH + 1) * PX;
    g.fillEllipse(0, shadowY, 10 * PX, 2 * PX);
  }

  /** Draw a filled rectangle in sprite-pixel coordinates */
  private px(
    g: Phaser.GameObjects.Graphics,
    color: number,
    sx: number,
    sy: number,
    w: number,
    h: number
  ): void {
    g.fillStyle(color, 1);
    g.fillRect(sx * PX, sy * PX, w * PX, h * PX);
  }

  startIdle(): void {
    if (this.isMoving || this.idleTween) return;
    this.idleTween = this.scene.tweens.add({
      targets: this,
      y: this.baseY - 2,
      duration: 900 + Math.random() * 300,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  stopIdle(): void {
    if (this.idleTween) {
      this.idleTween.stop();
      this.idleTween = undefined;
      this.y = this.baseY;
    }
  }

  walkTo(path: { x: number; y: number }[], onComplete?: () => void): void {
    if (this.walkTween) {
      this.walkTween.stop();
    }
    this.stopIdle();
    this.isMoving = true;

    if (path.length === 0) {
      this.isMoving = false;
      this.startIdle();
      onComplete?.();
      return;
    }

    const targets = path.map((p) => ({ x: p.x, y: p.y }));
    let currentIdx = 0;

    const moveToNext = () => {
      if (currentIdx >= targets.length) {
        this.isMoving = false;
        this.baseY = this.y;
        this.startIdle();
        onComplete?.();
        return;
      }

      const target = targets[currentIdx];
      const dx = target.x - this.x;
      const dy = target.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const duration = (dist / this.config.moveSpeed) * 1000;

      this.walkTween = this.scene.tweens.add({
        targets: this,
        x: target.x,
        y: target.y,
        duration: Math.max(duration, 100),
        ease: "Linear",
        onUpdate: () => {
          // Walking bounce — character bobs up and down
          const progress = this.walkTween?.progress ?? 0;
          const bounce = Math.abs(Math.sin(progress * Math.PI * 6)) * 3;
          this.sprite.setPosition(0, -bounce);
        },
        onComplete: () => {
          this.sprite.setPosition(0, 0);
          currentIdx++;
          moveToNext();
        },
      });
    };

    moveToNext();
  }

  showSpeech(text: string, emotion: Emotion): void {
    const bubbleY = this.y - this.spriteHeight / 2 - 12;
    this.bubbleManager.show(this.x, bubbleY, text, emotion);
  }

  showTradeEffect(): void {
    const particles = this.scene.add.graphics();
    particles.setDepth(200);

    const colors = [0xfbbf24, 0x34d399, 0xf87171, 0x60a5fa];
    const sparkles: { x: number; y: number; vx: number; vy: number; color: number; life: number }[] = [];

    for (let i = 0; i < 12; i++) {
      sparkles.push({
        x: this.x,
        y: this.y - this.spriteHeight / 2,
        vx: (Math.random() - 0.5) * 4,
        vy: -Math.random() * 4 - 1,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 1,
      });
    }

    const timer = this.scene.time.addEvent({
      delay: 30,
      repeat: 25,
      callback: () => {
        particles.clear();
        for (const s of sparkles) {
          s.x += s.vx;
          s.y += s.vy;
          s.vy += 0.12;
          s.life -= 0.04;
          if (s.life > 0) {
            particles.fillStyle(s.color, s.life);
            // Coin-like sparkle shapes
            particles.fillRect(s.x - 1, s.y - 1, 3, 3);
          }
        }
      },
    });

    this.scene.time.delayedCall(800, () => {
      timer.destroy();
      particles.destroy();
    });
  }

  getPosition(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }
}
