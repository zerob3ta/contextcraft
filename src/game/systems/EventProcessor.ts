import type { GameEvent, AgentMood } from "../config/events";
import { DEMO_TIMELINE } from "../config/events";
import type { TownScene } from "../scenes/TownScene";
import type { Emotion } from "../config/agents";

const MOOD_TO_EMOTION: Record<AgentMood, Emotion> = {
  bullish: "excited",
  bearish: "frustrated",
  uncertain: "cautious",
  confident: "excited",
  scared: "frustrated",
  manic: "excited",
  neutral: "neutral",
};

const IDLE_CHAT_MESSAGES: { message: string; emotion: Emotion }[] = [
  { message: "Any new markets coming?", emotion: "neutral" },
  { message: "Quiet day so far...", emotion: "neutral" },
  { message: "I think there's alpha here.", emotion: "excited" },
  { message: "Need more data before I move.", emotion: "cautious" },
  { message: "Who wants coffee?", emotion: "neutral" },
  { message: "Checking the feeds...", emotion: "neutral" },
  { message: "Something big is coming, I can feel it.", emotion: "excited" },
  { message: "Risk management is key.", emotion: "cautious" },
  { message: "Anyone seen Ghost? He vanished again.", emotion: "neutral" },
  { message: "Let's gooo!", emotion: "excited" },
  { message: "Hmm, interesting setup here...", emotion: "neutral" },
  { message: "Not touching that market. Too risky.", emotion: "frustrated" },
  { message: "Back from the newsroom. Nothing new.", emotion: "neutral" },
  { message: "My models are recalibrating...", emotion: "cautious" },
];

export class EventProcessor {
  private scene: TownScene | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private idleInterval: ReturnType<typeof setInterval> | null = null;
  private externalHandler?: (event: GameEvent) => void;

  /**
   * Bind to a TownScene instance. Must be called before processing events.
   */
  attach(scene: TownScene): void {
    this.scene = scene;
  }

  /**
   * Start the demo timeline. Events fire at their configured delays.
   */
  startTimeline(): void {
    if (!this.scene) return;

    for (const entry of DEMO_TIMELINE) {
      const timer = setTimeout(() => {
        this.processEvent(entry.event);
      }, entry.delayMs);
      this.timers.push(timer);
    }

    // After the last event, start idle loop
    const lastDelay = DEMO_TIMELINE[DEMO_TIMELINE.length - 1]?.delayMs ?? 0;
    const idleStartTimer = setTimeout(() => {
      this.startIdleLoop();
    }, lastDelay + 5000);
    this.timers.push(idleStartTimer);
  }

  /**
   * Process a single GameEvent, dispatching to the appropriate scene method.
   */
  processEvent(event: GameEvent): void {
    if (!this.scene) return;

    this.externalHandler?.(event);

    switch (event.type) {
      case "agent_move":
        this.scene.moveAgent(event.agentId, event.destination);
        break;

      case "agent_speak":
        this.scene.setAgentChatting(event.agentId);
        break;

      case "news_alert":
        // Handled by HUD — no Phaser overlay needed
        break;

      case "market_spawning":
        this.scene.showMarketOnExchange(event.question);
        break;

      case "price_update":
        this.scene.updateMarketPrice(event.marketId, event.fairValue, event.spread);
        break;

      case "trade_executed":
        this.scene.showTradeEffect(event.agentId);
        break;

      case "chat_message":
        this.scene.setAgentChatting(event.agentId);
        break;

      case "chat_directive":
        // Handled by HUD — agent will move via agent_move event
        break;

      case "mood_change":
        this.scene.setAgentMood(event.agentId, event.newMood);
        break;

      case "building_selected":
        // Handled by HUD only — no Phaser action needed
        break;

      case "market_rejected":
      case "market_failed":
      case "markets_synced":
      case "agent_directive":
      case "directive_fulfilled":
        // Handled by HUD only
        break;
    }
  }

  /**
   * Inject an event from external source (e.g. WebSocket).
   */
  injectEvent(event: GameEvent): void {
    this.processEvent(event);
  }

  /**
   * Register a handler that gets called for every processed event.
   * Useful for syncing React UI state.
   */
  onEvent(handler: (event: GameEvent) => void): void {
    this.externalHandler = handler;
  }

  /**
   * Start idle loop: agents randomly wander and chat.
   */
  private startIdleLoop(): void {
    if (this.idleInterval) return;

    this.idleInterval = setInterval(() => {
      if (!this.scene) return;

      const agentIds = this.scene.getAgentIds();

      // Random agent moves
      if (Math.random() < 0.3) {
        const agentId = agentIds[Math.floor(Math.random() * agentIds.length)];
        const destination = this.scene.getRandomBuilding();
        this.processEvent({
          type: "agent_move",
          agentId,
          destination,
          reason: "Wandering",
        });
      }

      // Random agent speaks
      if (Math.random() < 0.4) {
        const agentId = agentIds[Math.floor(Math.random() * agentIds.length)];
        const chat = IDLE_CHAT_MESSAGES[Math.floor(Math.random() * IDLE_CHAT_MESSAGES.length)];
        this.processEvent({
          type: "agent_speak",
          agentId,
          message: chat.message,
          emotion: chat.emotion,
        });
      }
    }, 3000);
  }

  /**
   * Stop all timers and idle loop.
   */
  destroy(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];

    if (this.idleInterval) {
      clearInterval(this.idleInterval);
      this.idleInterval = null;
    }

    this.scene = null;
    this.externalHandler = undefined;
  }
}
