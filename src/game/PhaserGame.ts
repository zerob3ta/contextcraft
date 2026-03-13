import Phaser from "phaser";
import { TownScene } from "./scenes/TownScene";
import { WideCampusScene } from "./scenes/WideCampusScene";
import { EventProcessor } from "./systems/EventProcessor";

let gameInstance: Phaser.Game | null = null;
let eventProcessorInstance: EventProcessor | null = null;

export interface PhaserGameHandle {
  game: Phaser.Game;
  eventProcessor: EventProcessor;
  getScene: () => TownScene | WideCampusScene | null;
  destroy: () => void;
}

/**
 * Create and configure the Phaser game instance.
 * Safe for Next.js — returns null during SSR.
 *
 * @param useCampus – if true, launch WideCampusScene instead of TownScene
 */
export function createPhaserGame(
  parentElement: HTMLElement,
  useCampus = false
): PhaserGameHandle | null {
  if (typeof window === "undefined") return null;

  // Prevent duplicate instances
  if (gameInstance) {
    gameInstance.destroy(true);
    gameInstance = null;
  }

  const eventProcessor = new EventProcessor();
  eventProcessorInstance = eventProcessor;

  const sceneKey = useCampus ? "WideCampusScene" : "TownScene";
  const sceneClass = useCampus ? WideCampusScene : TownScene;

  const game = new Phaser.Game({
    type: Phaser.CANVAS,
    width: 1280,
    height: 900,
    parent: parentElement,
    backgroundColor: "#1a1a2e",
    pixelArt: true,
    antialias: false,
    roundPixels: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: sceneClass,
  });

  gameInstance = game;

  // Attach event processor once scene boots
  game.events.on("ready", () => {
    const scene = game.scene.getScene(sceneKey) as
      | TownScene
      | WideCampusScene
      | null;
    if (scene) {
      eventProcessor.attach(scene);
    }
  });

  return {
    game,
    eventProcessor,
    getScene: () => {
      return game.scene.getScene(sceneKey) as
        | TownScene
        | WideCampusScene
        | null;
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
