import Phaser from "phaser";
import type { Emotion } from "../config/agents";

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

const MAX_WIDTH = 250;
const PADDING_X = 10;
const PADDING_Y = 6;
const TAIL_SIZE = 6;
const BORDER_RADIUS = 4;
const FONT_SIZE = 11;
const LINE_HEIGHT = 14;
const MAX_LINES = 4;
const DISPLAY_DURATION = 6000;
const FADE_DURATION = 500;
const MAX_BUBBLES = 2;

export class SpeechBubble extends Phaser.GameObjects.Container {
  private bg: Phaser.GameObjects.Graphics;
  private label: Phaser.GameObjects.Text;
  private emotion: Emotion;
  private convoColor: number | null;
  private fadeTimer?: Phaser.Time.TimerEvent;
  private bubbleHeight = 0;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    text: string,
    emotion: Emotion,
    convoColor: number | null = null
  ) {
    super(scene, x, y);
    this.emotion = emotion;
    this.convoColor = convoColor;

    this.label = scene.add
      .text(0, 0, text, {
        fontSize: `${FONT_SIZE}px`,
        fontFamily: "monospace",
        color: EMOTION_TEXT_COLORS[emotion],
        wordWrap: { width: MAX_WIDTH - PADDING_X * 2 },
        lineSpacing: 2,
        align: "left",
      })
      .setOrigin(0.5, 1);

    this.bg = scene.add.graphics();
    this.add(this.bg);
    this.add(this.label);

    this.drawBubble();

    this.setAlpha(0);
    this.setDepth(1000);
    scene.add.existing(this);

    scene.tweens.add({
      targets: this,
      alpha: 1,
      duration: 150,
      ease: "Linear",
    });

    this.fadeTimer = scene.time.delayedCall(DISPLAY_DURATION, () => {
      this.fadeOut();
    });
  }

  private drawBubble(): void {
    const textBounds = this.label.getBounds();
    const w = Math.max(textBounds.width + PADDING_X * 2, 40);
    const h = textBounds.height + PADDING_Y * 2;
    this.bubbleHeight = h + TAIL_SIZE;

    this.label.setPosition(0, -(TAIL_SIZE + PADDING_Y));

    const color = EMOTION_COLORS[this.emotion];
    this.bg.clear();

    // Bubble body
    this.bg.fillStyle(color, 1);
    this.bg.fillRoundedRect(
      -w / 2,
      -(h + TAIL_SIZE),
      w,
      h,
      BORDER_RADIUS
    );

    // Border
    this.bg.lineStyle(1, 0x475569, 0.6);
    this.bg.strokeRoundedRect(
      -w / 2,
      -(h + TAIL_SIZE),
      w,
      h,
      BORDER_RADIUS
    );

    // Tail
    this.bg.fillStyle(color, 1);
    this.bg.fillTriangle(
      -TAIL_SIZE / 2,
      -TAIL_SIZE,
      TAIL_SIZE / 2,
      -TAIL_SIZE,
      0,
      0
    );

    // Conversation color accent — thin left bar
    if (this.convoColor !== null) {
      const accentW = 3;
      this.bg.fillStyle(this.convoColor, 0.9);
      this.bg.fillRoundedRect(
        -w / 2,
        -(h + TAIL_SIZE),
        accentW,
        h,
        { tl: BORDER_RADIUS, bl: BORDER_RADIUS, tr: 0, br: 0 }
      );
    }
  }

  private clampLines(): void {
    const maxHeight = MAX_LINES * LINE_HEIGHT;
    const textBounds = this.label.getBounds();
    if (textBounds.height > maxHeight) {
      // Truncate by word until it fits within MAX_LINES
      const words = this.label.text.split(" ");
      while (words.length > 1) {
        words.pop();
        this.label.setText(words.join(" ") + "...");
        if (this.label.getBounds().height <= maxHeight) break;
      }
      // Redraw bubble with clamped text
      this.drawBubble();
    }
  }

  getHeight(): number {
    return this.bubbleHeight;
  }

  getBubbleX(): number {
    return this.x;
  }

  getBubbleY(): number {
    return this.y;
  }

  fadeOut(): void {
    if (!this.scene) return;
    this.scene.tweens.add({
      targets: this,
      alpha: 0,
      duration: FADE_DURATION,
      ease: "Linear",
      onComplete: () => {
        this.destroy();
      },
    });
  }

  forceDestroy(): void {
    this.fadeTimer?.destroy();
    this.destroy();
  }
}

/**
 * Manages speech bubbles for a single agent, stacking and limiting count.
 */
export class SpeechBubbleManager {
  private bubbles: SpeechBubble[] = [];
  private scene: Phaser.Scene;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  show(x: number, y: number, text: string, emotion: Emotion, convoColor: number | null = null): void {
    // Remove oldest if at max
    while (this.bubbles.length >= MAX_BUBBLES) {
      const oldest = this.bubbles.shift();
      oldest?.forceDestroy();
    }

    const bubble = new SpeechBubble(this.scene, x, y, text, emotion, convoColor);
    this.bubbles.push(bubble);

    // Reposition stack
    this.repositionStack(x, y);

    // Auto-remove from array when destroyed
    bubble.once("destroy", () => {
      const idx = this.bubbles.indexOf(bubble);
      if (idx !== -1) this.bubbles.splice(idx, 1);
    });
  }

  repositionStack(x: number, baseY: number): void {
    let offsetY = 0;
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.setPosition(x, baseY - offsetY);
      offsetY += b.getHeight() + 4;
    }
  }

  destroyAll(): void {
    for (const b of this.bubbles) {
      b.forceDestroy();
    }
    this.bubbles = [];
  }
}
