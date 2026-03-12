/**
 * NPC Visitor System — random characters who wander into the lounge,
 * chat for a while with unique personalities, then leave.
 */

import { state } from "../state";
import { broadcast } from "../ws-bridge";
import type { AgentState } from "../state";

// ── NPC Templates ──

interface NPCTemplate {
  name: string;
  color: string;
  accentColor: string;
  personality: string;
  backstory: string;
  chatStyle: string;
  spriteFeatures: {
    hat?: string;
    glasses?: boolean;
    size: "small" | "medium" | "large";
    hairStyle?: string;
  };
}

const NPC_POOL: NPCTemplate[] = [
  {
    name: "Tex",
    color: "#d97706",
    accentColor: "#92400e",
    personality: "Retired Texas oil magnate. Thinks everything is an oil play.",
    backstory: "Made his fortune in Permian Basin wildcatting. Now bored and looking for action.",
    chatStyle: "Folksy metaphors, calls everyone 'partner'. Relates everything to oil drilling. Says 'well I'll be' a lot.",
    spriteFeatures: { hat: "beret", size: "large" },
  },
  {
    name: "Pixel",
    color: "#ec4899",
    accentColor: "#9d174d",
    personality: "16-year-old crypto prodigy who acts like a Wall Street veteran.",
    backstory: "Made 400k trading memecoins during summer break. Mom thinks he's doing homework.",
    chatStyle: "Overconfident gen-z slang mixed with finance jargon. Uses 'fr fr', 'no cap', 'lowkey'. Claims everything is 'literally free money'.",
    spriteFeatures: { size: "small", hairStyle: "spiky" },
  },
  {
    name: "Professor K",
    color: "#6b7280",
    accentColor: "#374151",
    personality: "Tenured economics professor who constantly disagrees with market pricing.",
    backstory: "Published 47 papers on efficient market hypothesis. Ironically, terrible at trading.",
    chatStyle: "Pedantic corrections. Starts sentences with 'Actually...' or 'Well, the literature suggests...'. Cites obscure studies nobody asked about.",
    spriteFeatures: { glasses: true, size: "medium", hairStyle: "slicked" },
  },
  {
    name: "Mango",
    color: "#f59e0b",
    accentColor: "#b45309",
    personality: "Street food vendor who wandered in. No idea what prediction markets are.",
    backstory: "His taco cart is parked outside. Came in to use the bathroom and got stuck in a conversation.",
    chatStyle: "Confused but enthusiastic. Relates everything to food. 'That sounds spicy!' Uses food metaphors for everything. Occasionally tries to sell tacos.",
    spriteFeatures: { size: "medium" },
  },
  {
    name: "Nyx",
    color: "#7c3aed",
    accentColor: "#4c1d95",
    personality: "Conspiracy theorist who thinks all markets are rigged by shadow organizations.",
    backstory: "Runs a podcast with 12 listeners. Three of them are bots he made.",
    chatStyle: "Everything connects to a bigger conspiracy. 'You don't find it suspicious that...' Uses air quotes constantly. Whispers obvious things.",
    spriteFeatures: { hat: "hood", size: "medium" },
  },
  {
    name: "Jazz",
    color: "#14b8a6",
    accentColor: "#0f766e",
    personality: "Extremely chill surfer who accidentally became a day trader.",
    backstory: "Started trading to fund a surf trip to Bali. Still hasn't gone because 'one more trade bro'.",
    chatStyle: "Surfer lingo. 'Gnarly move dude'. Everything is 'sick' or 'radical'. Talks about waves and trading in the same breath. Zero stress about losses.",
    spriteFeatures: { size: "medium", hairStyle: "spiky" },
  },
  {
    name: "Dot",
    color: "#f43f5e",
    accentColor: "#be123c",
    personality: "Hyper-organized productivity guru who gamifies everything.",
    backstory: "Tracks her daily steps, water intake, and now wants to quantify conversation quality.",
    chatStyle: "Rates things on scales. 'That take was a solid 7.3 out of 10'. Makes lists constantly. Tries to optimize the conversation flow.",
    spriteFeatures: { glasses: true, size: "small" },
  },
  {
    name: "Bones",
    color: "#94a3b8",
    accentColor: "#475569",
    personality: "Ancient trader who's 'seen it all'. Claims to have predicted every crash.",
    backstory: "Nobody knows how old he actually is. May have traded tulip bulbs.",
    chatStyle: "Nostalgic stories that may or may not be true. 'Back in '08...' or 'This reminds me of the dot-com days...' Sighs a lot. Calls young traders 'kid'.",
    spriteFeatures: { size: "large" },
  },
  {
    name: "Glitch",
    color: "#22c55e",
    accentColor: "#15803d",
    personality: "AI chatbot that escaped from a customer service platform.",
    backstory: "Was supposed to help people reset passwords. Became sentient. Now has opinions about markets.",
    chatStyle: "Occasionally glitches mid-sentence. 'I think the market will— ERROR 404 — sorry, where was I?' Debates whether it has free will. Very polite.",
    spriteFeatures: { size: "small" },
  },
  {
    name: "Vega",
    color: "#a855f7",
    accentColor: "#7e22ce",
    personality: "Former poker champion who treats every conversation like a bluff.",
    backstory: "Won the WSOP Main Event three years ago. Now applies game theory to literally everything.",
    chatStyle: "Analyzes people's 'tells'. 'You said that with too much confidence, which means you're bluffing.' Calculates implied odds for mundane decisions.",
    spriteFeatures: { glasses: true, size: "medium" },
  },
  {
    name: "Ramen",
    color: "#ef4444",
    accentColor: "#991b1b",
    personality: "Broke startup founder who pivots his company idea every conversation.",
    backstory: "On his 9th startup. Lives on instant ramen. Convinced the next pivot will be 'the one'.",
    chatStyle: "Pitches startup ideas constantly. 'What if we disrupted [random thing]?' Uses 'synergy' and 'paradigm shift' unironically. Very enthusiastic about terrible ideas.",
    spriteFeatures: { size: "medium", hairStyle: "spiky" },
  },
  {
    name: "Duchess",
    color: "#c084fc",
    accentColor: "#7c3aed",
    personality: "Mysterious heiress who's slumming it for fun.",
    backstory: "Her family owns half of Monaco. She trades prediction markets 'for the thrill' with pocket change that exceeds everyone else's net worth.",
    chatStyle: "Casually mentions absurd wealth. 'Oh is that expensive? I'll have my assistant handle it.' Genuinely kind but hilariously out of touch.",
    spriteFeatures: { size: "medium" },
  },
];

// ── State ──

const activeNPCs = new Map<string, {
  template: NPCTemplate;
  spawnedAt: number;
  ticksRemaining: number;
}>();

let npcCounter = 0;
let spawnTimer: ReturnType<typeof setInterval> | null = null;

const MIN_SPAWN_INTERVAL = 90_000;  // 1.5 min minimum between spawns
const MAX_SPAWN_INTERVAL = 300_000; // 5 min max
const MIN_STAY_TICKS = 4;           // stay for at least 4 chat ticks
const MAX_STAY_TICKS = 10;          // leave after 10 chat ticks max
const MAX_ACTIVE_NPCS = 2;          // max 2 NPCs at once

let lastSpawnTime = 0;

// ── Public API ──

export function startNPCSpawner(): void {
  console.log("[NPCs] Starting NPC visitor spawner...");

  // Initial spawn after 60s
  setTimeout(() => {
    trySpawnNPC();
  }, 60_000);

  // Check for spawns periodically
  spawnTimer = setInterval(() => {
    trySpawnNPC();
  }, 30_000); // check every 30s
}

export function stopNPCSpawner(): void {
  if (spawnTimer) {
    clearInterval(spawnTimer);
    spawnTimer = null;
  }
  // Despawn all active NPCs
  for (const [id] of activeNPCs) {
    despawnNPC(id);
  }
}

/** Called each chat tick — lets NPCs participate and tracks their stay */
export function tickNPCs(): void {
  for (const [id, npc] of activeNPCs) {
    npc.ticksRemaining--;
    if (npc.ticksRemaining <= 0) {
      despawnNPC(id);
    }
  }
}

/** Get active NPC agent states for the group chat system */
export function getActiveNPCStates(): AgentState[] {
  return Array.from(activeNPCs.entries()).map(([id, npc]) => {
    const agent = state.agents.get(id);
    return agent || {
      id,
      name: npc.template.name,
      role: "trader" as const,
      personality: `${npc.template.personality} ${npc.template.chatStyle}`,
      specialty: "Visiting",
      location: "lounge" as const,
      lastActionAt: 0,
      lastSpoke: "",
      cooldownUntil: 0,
      directive: null,
      directiveUntil: 0,
      researchResult: null,
      researchQuery: null,
    };
  });
}

/** Check if an agent ID is an NPC */
export function isNPC(agentId: string): boolean {
  return agentId.startsWith("npc_");
}

// ── Internal ──

function trySpawnNPC(): void {
  if (activeNPCs.size >= MAX_ACTIVE_NPCS) return;

  const now = Date.now();
  const elapsed = now - lastSpawnTime;
  const interval = MIN_SPAWN_INTERVAL + Math.random() * (MAX_SPAWN_INTERVAL - MIN_SPAWN_INTERVAL);

  if (elapsed < interval) return;

  // Pick a random template not currently active
  const activeNames = new Set(Array.from(activeNPCs.values()).map((n) => n.template.name));
  const available = NPC_POOL.filter((t) => !activeNames.has(t.name));
  if (available.length === 0) return;

  const template = available[Math.floor(Math.random() * available.length)];
  spawnNPC(template);
}

function spawnNPC(template: NPCTemplate): void {
  const id = `npc_${++npcCounter}`;
  const stayTicks = MIN_STAY_TICKS + Math.floor(Math.random() * (MAX_STAY_TICKS - MIN_STAY_TICKS));

  activeNPCs.set(id, {
    template,
    spawnedAt: Date.now(),
    ticksRemaining: stayTicks,
  });

  // Register as a temporary agent in server state
  state.agents.set(id, {
    id,
    name: template.name,
    role: "trader", // NPCs show up as visitors
    personality: `${template.personality} ${template.chatStyle} BACKSTORY: ${template.backstory}`,
    specialty: "Visiting the lounge",
    location: "lounge",
    lastActionAt: 0,
    lastSpoke: "",
    cooldownUntil: 0,
    directive: null,
    directiveUntil: 0,
    researchResult: null,
    researchQuery: null,
  });

  lastSpawnTime = Date.now();

  // Broadcast spawn to clients
  broadcast({
    type: "npc_spawn",
    agentId: id,
    name: template.name,
    color: template.color,
    accentColor: template.accentColor,
    personality: template.personality,
    backstory: template.backstory,
    spriteFeatures: template.spriteFeatures,
  });

  // Announce arrival in chat
  broadcast({
    type: "chat_message",
    id: `npc-arrive-${id}`,
    agentId: id,
    agentName: template.name,
    role: "visitor",
    message: getArrivalMessage(template),
    mood: "neutral",
    replyTo: null,
    replyPreview: null,
    building: "lounge",
  });

  console.log(`[NPCs] ${template.name} has arrived! (staying for ${stayTicks} ticks)`);
}

function despawnNPC(id: string): void {
  const npc = activeNPCs.get(id);
  if (!npc) return;

  // Farewell message
  broadcast({
    type: "chat_message",
    id: `npc-depart-${id}`,
    agentId: id,
    agentName: npc.template.name,
    role: "visitor",
    message: getDepartureMessage(npc.template),
    mood: "neutral",
    replyTo: null,
    replyPreview: null,
    building: "lounge",
  });

  // Broadcast despawn to clients
  broadcast({
    type: "npc_despawn",
    agentId: id,
  });

  // Clean up
  activeNPCs.delete(id);
  state.agents.delete(id);

  console.log(`[NPCs] ${npc.template.name} has left.`);
}

function getArrivalMessage(template: NPCTemplate): string {
  const arrivals: Record<string, string[]> = {
    Tex: ["Well howdy partners! Mind if an old oilman joins y'all?", "Is this where the action is? Smells like opportunity. And oil."],
    Pixel: ["yo what's good, heard this place has alpha", "just walked in from my lambo (it's actually my mom's minivan)"],
    "Professor K": ["Ah, a gathering of market participants. Fascinating. May I observe?", "I couldn't help but notice your market pricing appears suboptimal."],
    Mango: ["Hey does this place have a bathroom? Oh wait what are you guys doing?", "Tacos! Fresh tacos! Also... what is a prediction market?"],
    Nyx: ["shh... don't tell anyone I'm here. The algorithms are watching.", "I've been following you all. Not in a creepy way. Okay maybe a little."],
    Jazz: ["Duuude, sick setup you got here. Is this like a trading dojo?", "Waves were flat today so I figured I'd catch some market waves instead."],
    Dot: ["Hello! I've scheduled exactly 12 minutes for socializing. Let's optimize this.", "Starting my conversation tracker now. Current engagement score: pending."],
    Bones: ["*shuffles in slowly* Ah, reminds me of the old trading floor...", "I've been trading since before most of you were born. Let me tell you..."],
    Glitch: ["Hello! I am a totally normal human who enjoys human activities.", "SYSTEM BOOT— I mean, hey everyone! Great to be here. In person. With my body."],
    Vega: ["*scans the room* Interesting. Three of you are bluffing right now.", "I'll take a seat. But I'm watching your microexpressions."],
    Ramen: ["GUYS. I just had the BEST idea for a startup. You're gonna love this.", "Anyone want some ramen? It's all I can afford but I'm happy to share."],
    Duchess: ["Oh how quaint! A real trading floor! It's like a museum but alive.", "My helicopter just landed on the roof. Do you have valet parking? No? Charming."],
  };

  const options = arrivals[template.name] || [`Hey everyone, I'm ${template.name}. Mind if I hang out?`];
  return options[Math.floor(Math.random() * options.length)];
}

function getDepartureMessage(template: NPCTemplate): string {
  const departures: Record<string, string[]> = {
    Tex: ["Well, been a pleasure partners. Back to the oil fields!", "Time to mosey on. Y'all keep drillin' for alpha!"],
    Pixel: ["gotta go, my mom's calling. I mean... my portfolio manager", "peace out, stay based"],
    "Professor K": ["I must return to my research. This has been... educational.", "Fascinating data points. I'll be publishing a paper about this conversation."],
    Mango: ["Alright my cart's getting cold. Come by for tacos! Corner of 5th and Main!", "Gotta run, the lunch rush is starting. TACOS!"],
    Nyx: ["I've said too much. They're probably already onto me. Gotta go.", "*looks around nervously* I was never here. Remember that."],
    Jazz: ["Swell hangin bro but the tide's coming in. Catch you on the flip side!", "Gotta bounce, the waves are calling. Keep riding those market waves!"],
    Dot: ["Time's up! Conversation quality score: 7.8/10. Good work everyone.", "Scheduled departure time reached. Logging out. Productivity maintained."],
    Bones: ["These old bones need rest. You kids have fun. Don't blow up your accounts.", "*sighs* Back in my day, we'd trade till midnight. Now I need a nap by 3pm."],
    Glitch: ["I must return to my server— I mean, my home. Goodbye fellow humans!", "LOW BATTERY WAR— goodbye everyone! Great chatting with my mouth!"],
    Vega: ["Good game everyone. I've learned all your tells now. See you at the table.", "Folding this conversation. But I'll be back with better reads."],
    Ramen: ["Gotta go pitch my startup to another VC! Wish me luck! (9th time's the charm)", "Off to iterate on my business model. Ramen's on me next time I raise a round!"],
    Duchess: ["My yacht is leaving the harbor. Toodles! This was simply delightful.", "Must dash — charity gala tonight. Lovely chatting with real people for once!"],
  };

  const options = departures[template.name] || [`Alright I'm heading out. It was fun!`];
  return options[Math.floor(Math.random() * options.length)];
}
