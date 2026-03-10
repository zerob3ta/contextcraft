import Phaser from "phaser";
import { TownScene } from "./scenes/TownScene";
import { EventProcessor } from "./systems/EventProcessor";

let gameInstance: Phaser.Game | null = null;
let eventProcessorInstance: EventProcessor | null = null;

export interface PhaserGameHandle {
  game: Phaser.Game;
  eventProcessor: EventProcessor;
  getScene: () => TownScene | null;
  destroy: () => void;
}

/**
 * Create and configure the Phaser game instance.
 * Safe for Next.js — returns null during SSR.
 */
export function createPhaserGame(
  parentElement: HTMLElement
): PhaserGameHandle | null {
  if (typeof window === "undefined") return null;

  // Prevent duplicate instances
  if (gameInstance) {
    gameInstance.destroy(true);
    gameInstance = null;
  }

  const eventProcessor = new EventProcessor();
  eventProcessorInstance = eventProcessor;

  const game = new Phaser.Game({
    type: Phaser.CANVAS,
    width: 1280,
    height: 720,
    parent: parentElement,
    backgroundColor: "#1a1a2e",
    pixelArt: true,
    antialias: false,
    roundPixels: true,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: TownScene,
  });

  gameInstance = game;

  // Attach event processor once scene boots
  game.events.on("ready", () => {
    const scene = game.scene.getScene("TownScene") as TownScene | null;
    if (scene) {
      eventProcessor.attach(scene);
      eventProcessor.startTimeline();
    }
  });

  return {
    game,
    eventProcessor,
    getScene: () => {
      return game.scene.getScene("TownScene") as TownScene | null;
    },
    destroy: () => {
      eventProcessor.destroy();
      game.destroy(true);
      gameInstance = null;
      eventProcessorInstance = null;
    },
  };
}

/**
 * Get the current event processor (for injecting external events from React/WebSocket).
 */
export function getEventProcessor(): EventProcessor | null {
  return eventProcessorInstance;
}
