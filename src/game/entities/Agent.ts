import Phaser from "phaser";
import type { AgentConfig, Emotion } from "../config/agents";
import type { AgentMood } from "../config/events";
import { SpeechBubbleManager } from "./SpeechBubble";

// Scale factor: 1 "pixel" in our sprite = this many canvas pixels
const PX = 2;

// Height map per size variant (in sprite-pixels)
const HEIGHT_MAP: Record<string, number> = {
  small: 14,
  medium: 16,
  large: 18,
};

// Mood emoji mapping
const MOOD_EMOJI: Record<AgentMood, string> = {
  bullish: "🐂",
  bearish: "🐻",
  uncertain: "🤔",
  confident: "😎",
  scared: "😰",
  manic: "🤪",
  neutral: "",
};

// Mood glow colors
const MOOD_GLOW: Record<AgentMood, number> = {
  bullish: 0x4ade80,
  bearish: 0xf87171,
  uncertain: 0xfacc15,
  confident: 0x60a5fa,
  scared: 0x6b7280,
  manic: 0xa78bfa,
  neutral: 0x000000,
};

// Agent visual state
export type AgentState = "idle" | "chatting" | "working";

export class Agent extends Phaser.GameObjects.Container {
  public agentId: string;
  public config: AgentConfig;

  private sprite: Phaser.GameObjects.Graphics;
  private nameLabel: Phaser.GameObjects.Text;
  private directiveLabel: Phaser.GameObjects.Text;
  private bubbleManager: SpeechBubbleManager;
  private idleTween?: Phaser.Tweens.Tween;
  private walkTween?: Phaser.Tweens.Tween;
  private spriteHeight: number;
  private isMoving = false;
  private baseY = 0;
  private convoColor: number | null = null;

  // Mood system
  private currentMood: AgentMood = "neutral";
  private moodBubble?: Phaser.GameObjects.Container;
  private moodBubbleTween?: Phaser.Tweens.Tween;
  private moodGlow?: Phaser.GameObjects.Graphics;

  // State indicator
  private agentState: AgentState = "idle";
  private stateIndicator?: Phaser.GameObjects.Graphics;
  private stateDotTween?: Phaser.Tweens.Tween;

  // Track whether this agent has been destroyed to guard deferred callbacks
  private isDestroyed = false;

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

    this.directiveLabel = scene.add
      .text(0, this.spriteHeight / 2 + 12, "", {
        fontSize: "7px",
        fontFamily: "monospace",
        color: config.color,
        align: "center",
        stroke: "#0f172a",
        strokeThickness: 2,
        wordWrap: { width: 120 },
      })
      .setOrigin(0.5, 0)
      .setAlpha(0);
    this.add(this.directiveLabel);

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
    if (this.isDestroyed || this.isMoving || this.idleTween) return;
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
      if (this.isDestroyed) return;
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
          if (this.isDestroyed) return;
          const progress = this.walkTween?.progress ?? 0;
          const bounce = Math.abs(Math.sin(progress * Math.PI * 6)) * 3;
          this.sprite.setPosition(0, -bounce);
        },
        onComplete: () => {
          if (this.isDestroyed) return;
          this.sprite.setPosition(0, 0);
          currentIdx++;
          moveToNext();
        },
      });
    };

    moveToNext();
  }

  showSpeech(text: string, emotion: Emotion): void {
    if (this.isDestroyed) return;
    const bubbleY = this.y - this.spriteHeight / 2 - 12;
    this.bubbleManager.show(this.x, bubbleY, text, emotion, this.convoColor);
  }

  showSpeechOffset(text: string, emotion: Emotion, offsetX: number): void {
    if (this.isDestroyed) return;
    const bubbleY = this.y - this.spriteHeight / 2 - 12;
    this.bubbleManager.show(this.x + offsetX, bubbleY, text, emotion, this.convoColor);
  }

  showTradeEffect(): void {
    if (this.isDestroyed) return;
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

  setConvoColor(color: number | null): void {
    this.convoColor = color;
    // Add/remove a subtle colored underline indicator
    if (color !== null) {
      this.nameLabel.setColor(`#${color.toString(16).padStart(6, "0")}`);
    } else {
      this.nameLabel.setColor("#e2e8f0");
    }
  }

  getConvoColor(): number | null {
    return this.convoColor;
  }

  setDirective(directive: string): void {
    if (this.isDestroyed) return;
    if (!directive) {
      if (this.directiveLabel.alpha > 0) {
        this.scene.tweens.add({
          targets: this.directiveLabel,
          alpha: 0,
          duration: 300,
        });
      }
      return;
    }
    const display = directive.length > 35 ? directive.slice(0, 33) + "..." : directive;
    this.directiveLabel.setText(`→ ${display}`);
    this.scene.tweens.add({
      targets: this.directiveLabel,
      alpha: 0.8,
      duration: 300,
    });
  }

  showActionToast(result: string): void {
    if (this.isDestroyed) return;

    const ROLE_COLORS: Record<string, number> = {
      creator: 0xa78bfa,
      pricer: 0x22d3ee,
      trader: 0xfb923c,
    };

    const roleColor = ROLE_COLORS[this.config.role] || 0x94a3b8;

    const container = this.scene.add.container(this.x, this.y - this.spriteHeight / 2 - 16);
    container.setDepth(1001);
    container.setAlpha(0);

    const label = this.scene.add.text(0, 0, `✦ ${result}`, {
      fontSize: "10px",
      fontFamily: "monospace",
      color: "#e2e8f0",
      wordWrap: { width: 200 },
      lineSpacing: 2,
    }).setOrigin(0.5, 1);

    const bounds = label.getBounds();
    const padX = 10;
    const padY = 6;
    const w = Math.max(bounds.width + padX * 2, 60);
    const h = bounds.height + padY * 2;
    const accentW = 3;

    label.setPosition(accentW / 2, -(padY));

    const bg = this.scene.add.graphics();
    bg.fillStyle(0x1e293b, 0.95);
    bg.fillRoundedRect(-w / 2, -(h), w, h, 4);
    bg.lineStyle(1, roleColor, 0.4);
    bg.strokeRoundedRect(-w / 2, -(h), w, h, 4);
    bg.fillStyle(roleColor, 0.9);
    bg.fillRoundedRect(-w / 2, -(h), accentW, h, { tl: 4, bl: 4, tr: 0, br: 0 });

    container.add(bg);
    container.add(label);
    this.scene.add.existing(container);

    this.scene.tweens.add({
      targets: container,
      alpha: 1,
      y: container.y - 8,
      duration: 300,
      ease: "Back.easeOut",
    });

    // Fade out after 8s — container is a standalone scene object, safe even if agent is destroyed
    const sceneRef = this.scene;
    sceneRef.time.delayedCall(8000, () => {
      if (!sceneRef?.tweens) return;
      sceneRef.tweens.add({
        targets: container,
        alpha: 0,
        y: container.y - 12,
        duration: 500,
        ease: "Cubic.easeIn",
        onComplete: () => container.destroy(),
      });
    });
  }

  // ── Mood System ──────────────────────────────────────────

  setMood(mood: AgentMood): void {
    if (this.isDestroyed) return;
    if (mood === this.currentMood) return;
    this.currentMood = mood;

    this.updateMoodGlow(mood);
    this.updateMoodBubble(mood);

    if (mood !== "neutral") {
      const glowColor = MOOD_GLOW[mood];
      const hex = `#${glowColor.toString(16).padStart(6, "0")}`;
      this.nameLabel.setColor(hex);
      this.scene.time.delayedCall(3000, () => {
        if (this.isDestroyed) return;
        if (this.currentMood === mood) {
          this.nameLabel.setColor(this.convoColor
            ? `#${this.convoColor.toString(16).padStart(6, "0")}`
            : "#e2e8f0"
          );
        }
      });
    }
  }

  getMood(): AgentMood {
    return this.currentMood;
  }

  private updateMoodGlow(mood: AgentMood): void {
    if (this.moodGlow) {
      this.moodGlow.destroy();
      this.moodGlow = undefined;
    }

    if (mood === "neutral") return;
    if (this.isDestroyed) return;

    const glow = this.scene.add.graphics();
    const glowColor = MOOD_GLOW[mood];
    const size = this.spriteHeight;

    glow.fillStyle(glowColor, 0.15);
    glow.fillEllipse(0, (size / 2) + 4, size * 1.2, 8);
    glow.lineStyle(1, glowColor, 0.3);
    glow.strokeEllipse(0, 0, size * 0.8, size * 1.1);

    this.add(glow);
    this.moodGlow = glow;
    this.sendToBack(glow);

    this.scene.time.delayedCall(15000, () => {
      if (this.isDestroyed) return;
      if (this.moodGlow === glow) {
        this.scene.tweens.add({
          targets: glow,
          alpha: 0,
          duration: 2000,
          onComplete: () => {
            glow.destroy();
            if (this.moodGlow === glow) this.moodGlow = undefined;
          },
        });
      }
    });
  }

  private updateMoodBubble(mood: AgentMood): void {
    if (this.moodBubble) {
      if (this.moodBubbleTween) {
        this.moodBubbleTween.stop();
        this.moodBubbleTween = undefined;
      }
      this.moodBubble.destroy();
      this.moodBubble = undefined;
    }

    const emoji = MOOD_EMOJI[mood];
    if (!emoji) return;
    if (this.isDestroyed) return;

    const bubbleY = -this.spriteHeight / 2 - 20;

    const container = this.scene.add.container(0, bubbleY);
    container.setDepth(150);

    const bg = this.scene.add.graphics();
    bg.fillStyle(0xffffff, 0.85);
    bg.fillRoundedRect(-10, -8, 20, 16, 6);
    bg.fillStyle(0xffffff, 0.6);
    bg.fillCircle(-4, 10, 2);
    bg.fillCircle(-2, 14, 1.5);

    const emojiText = this.scene.add.text(0, 0, emoji, {
      fontSize: "11px",
      fontFamily: "monospace",
    }).setOrigin(0.5, 0.5);

    container.add(bg);
    container.add(emojiText);
    this.add(container);
    container.setAlpha(0);

    this.scene.tweens.add({
      targets: container,
      alpha: 1,
      y: bubbleY - 4,
      duration: 300,
      ease: "Back.easeOut",
    });

    this.moodBubbleTween = this.scene.tweens.add({
      targets: container,
      y: bubbleY - 7,
      duration: 1500,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    this.moodBubble = container;

    this.scene.time.delayedCall(10000, () => {
      if (this.isDestroyed) return;
      if (this.moodBubble === container) {
        this.scene.tweens.add({
          targets: container,
          alpha: 0,
          duration: 1000,
          onComplete: () => {
            if (this.moodBubbleTween) {
              this.moodBubbleTween.stop();
              this.moodBubbleTween = undefined;
            }
            container.destroy();
            if (this.moodBubble === container) this.moodBubble = undefined;
          },
        });
      }
    });
  }

  // ── State Indicator ─────────────────────────────────────

  setAgentState(state: AgentState): void {
    if (this.isDestroyed) return;
    const changed = state !== this.agentState;
    this.agentState = state;
    if (changed) {
      this.updateStateIndicator();
    }

    // Hide mood bubble while chatting so chat icon is visible
    if (state === "chatting" && this.moodBubble) {
      this.moodBubble.setVisible(false);
    } else if (state !== "chatting" && this.moodBubble) {
      this.moodBubble.setVisible(true);
    }
  }

  getAgentState(): AgentState {
    return this.agentState;
  }

  private updateStateIndicator(): void {
    if (this.stateIndicator) {
      if (this.stateDotTween) {
        this.stateDotTween.stop();
        this.stateDotTween = undefined;
      }
      this.stateIndicator.destroy();
      this.stateIndicator = undefined;
    }

    const g = this.scene.add.graphics();
    const dotY = -this.spriteHeight / 2 - 6;

    switch (this.agentState) {
      case "chatting": {
        // Small speech bubble icon
        const bx = 0;
        const by = dotY - 2;
        // Bubble body
        g.fillStyle(0xffffff, 0.85);
        g.fillRoundedRect(bx - 7, by - 5, 14, 10, 3);
        // Tail
        g.fillTriangle(bx - 2, by + 5, bx + 2, by + 5, bx - 4, by + 9);
        // Three dots inside
        g.fillStyle(0x4ade80, 0.9);
        g.fillCircle(bx - 3, by, 1.2);
        g.fillCircle(bx, by, 1.2);
        g.fillCircle(bx + 3, by, 1.2);
        // Gentle pulse
        this.stateDotTween = this.scene.tweens.add({
          targets: g,
          alpha: 0.5,
          duration: 800,
          yoyo: true,
          repeat: -1,
          ease: "Sine.easeInOut",
        });
        break;
      }
      case "working": {
        // Wrench/gear icon — small spinning indicator
        g.fillStyle(0xfbbf24, 0.9);
        g.fillRect(-3, dotY - 1, 2, 2);
        g.fillRect(1, dotY - 1, 2, 2);
        g.fillRect(-1, dotY - 3, 2, 2);
        g.fillRect(-1, dotY + 1, 2, 2);
        // Slow pulse
        this.stateDotTween = this.scene.tweens.add({
          targets: g,
          alpha: 0.5,
          duration: 1200,
          yoyo: true,
          repeat: -1,
          ease: "Sine.easeInOut",
        });
        break;
      }
      case "idle":
        // No indicator for idle
        g.destroy();
        return;
    }

    this.add(g);
    this.stateIndicator = g;
  }

  getPosition(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  /** Clean up ALL tweens and timers before destroying to prevent orphaned callbacks */
  destroy(fromScene?: boolean): void {
    this.isDestroyed = true;
    if (this.walkTween) {
      this.walkTween.stop();
      this.walkTween = undefined;
    }
    if (this.idleTween) {
      this.idleTween.stop();
      this.idleTween = undefined;
    }
    if (this.moodBubbleTween) {
      this.moodBubbleTween.stop();
      this.moodBubbleTween = undefined;
    }
    if (this.stateDotTween) {
      this.stateDotTween.stop();
      this.stateDotTween = undefined;
    }
    if (this.moodBubble) {
      this.moodBubble.destroy();
      this.moodBubble = undefined;
    }
    if (this.moodGlow) {
      this.moodGlow.destroy();
      this.moodGlow = undefined;
    }
    if (this.stateIndicator) {
      this.stateIndicator.destroy();
      this.stateIndicator = undefined;
    }
    this.isMoving = false;
    super.destroy(fromScene);
  }
}
