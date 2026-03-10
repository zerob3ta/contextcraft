import type { GameEvent } from "../game/config/events";
import { DEMO_TIMELINE } from "../game/config/events";

type Listener = (event: GameEvent) => void;

class GameEventBus {
  private listeners: Set<Listener> = new Set();
  private timeouts: ReturnType<typeof setTimeout>[] = [];
  private demoStarted = false;

  /** Subscribe to all game events. Returns an unsubscribe function. */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Emit an event to all listeners */
  emit(event: GameEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[GameEventBus] Listener error:", err);
      }
    }
  }

  /** Start the demo timeline so HUD updates even before Phaser is wired up */
  startDemoTimeline(): void {
    if (this.demoStarted) return;
    this.demoStarted = true;

    for (const entry of DEMO_TIMELINE) {
      const t = setTimeout(() => {
        this.emit(entry.event);
      }, entry.delayMs);
      this.timeouts.push(t);
    }
  }

  /** Stop all scheduled demo events */
  stopDemoTimeline(): void {
    for (const t of this.timeouts) {
      clearTimeout(t);
    }
    this.timeouts = [];
    this.demoStarted = false;
  }

  /** Reset everything */
  destroy(): void {
    this.stopDemoTimeline();
    this.listeners.clear();
  }
}

/** Singleton event bus shared between Phaser and React */
export const gameEventBus = new GameEventBus();
