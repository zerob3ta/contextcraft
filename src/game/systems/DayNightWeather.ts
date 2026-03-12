import Phaser from "phaser";

/**
 * Day/Night cycle + Weather effects for the TownScene.
 *
 * Time runs at ~1 game hour per 30 real seconds (full cycle = 12 min).
 * Weather changes randomly every 2-5 minutes.
 */

export type TimeOfDay = "dawn" | "day" | "dusk" | "night";
export type Weather = "clear" | "cloudy" | "rain" | "storm";

// Game-hour boundaries
const DAWN_START = 5;
const DAY_START = 7;
const DUSK_START = 18;
const NIGHT_START = 20;

// Tint configs per time of day { color, alpha }
const TIME_TINTS: Record<TimeOfDay, { color: number; alpha: number }> = {
  dawn: { color: 0xff9933, alpha: 0.12 },
  day: { color: 0x000000, alpha: 0 },
  dusk: { color: 0x9933cc, alpha: 0.18 },
  night: { color: 0x0a0a2a, alpha: 0.45 },
};

// Weather tint modifiers
const WEATHER_TINTS: Record<Weather, { color: number; alpha: number }> = {
  clear: { color: 0x000000, alpha: 0 },
  cloudy: { color: 0x555566, alpha: 0.08 },
  rain: { color: 0x334455, alpha: 0.12 },
  storm: { color: 0x1a1a33, alpha: 0.2 },
};

const MS_PER_GAME_HOUR = 30_000; // 30s real = 1 game hour

export class DayNightWeather {
  private scene: Phaser.Scene;
  private overlay: Phaser.GameObjects.Graphics;
  private starsGfx: Phaser.GameObjects.Graphics;
  private rainGfx: Phaser.GameObjects.Graphics;
  private cloudContainers: Phaser.GameObjects.Graphics[] = [];

  private gameHour = 10; // start at 10am
  private startTime = Date.now();
  private currentTime: TimeOfDay = "day";
  private currentWeather: Weather = "clear";
  private nextWeatherChange = Date.now() + 120_000 + Math.random() * 180_000;

  // Rain particles
  private rainDrops: { x: number; y: number; speed: number; length: number }[] = [];

  // Stars
  private stars: { x: number; y: number; size: number; twinkleOffset: number }[] = [];

  // Moon
  private moonGfx: Phaser.GameObjects.Graphics;

  // Lightning
  private lightningTimer = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;

    // Stars layer (behind overlay)
    this.starsGfx = scene.add.graphics();
    this.starsGfx.setDepth(4998);
    this.starsGfx.setScrollFactor(0);

    // Moon
    this.moonGfx = scene.add.graphics();
    this.moonGfx.setDepth(4998);
    this.moonGfx.setScrollFactor(0);

    // Rain layer
    this.rainGfx = scene.add.graphics();
    this.rainGfx.setDepth(5001);
    this.rainGfx.setScrollFactor(0);

    // Main tint overlay — covers entire viewport
    this.overlay = scene.add.graphics();
    this.overlay.setDepth(5000);
    this.overlay.setScrollFactor(0); // stays fixed on screen

    // Generate star positions
    for (let i = 0; i < 80; i++) {
      this.stars.push({
        x: Math.random() * 1400,
        y: Math.random() * 400, // upper portion of sky
        size: Math.random() < 0.3 ? 2 : 1,
        twinkleOffset: Math.random() * Math.PI * 2,
      });
    }

    // Start update loop
    scene.time.addEvent({
      delay: 100, // 10fps update for smooth transitions
      loop: true,
      callback: () => this.tick(),
    });
  }

  private tick(): void {
    const elapsed = Date.now() - this.startTime;
    this.gameHour = (10 + elapsed / MS_PER_GAME_HOUR) % 24;

    // Determine time of day
    const newTime = this.calcTimeOfDay();
    this.currentTime = newTime;

    // Weather changes
    if (Date.now() >= this.nextWeatherChange) {
      this.changeWeather();
      this.nextWeatherChange = Date.now() + 120_000 + Math.random() * 180_000;
    }

    this.drawOverlay();
    this.drawStars();
    this.drawMoon();
    this.drawRain();
    this.drawLightning();
  }

  private calcTimeOfDay(): TimeOfDay {
    if (this.gameHour >= NIGHT_START || this.gameHour < DAWN_START) return "night";
    if (this.gameHour >= DUSK_START) return "dusk";
    if (this.gameHour >= DAY_START) return "day";
    return "dawn";
  }

  private drawOverlay(): void {
    this.overlay.clear();

    const cam = this.scene.cameras.main;
    const w = cam.width;
    const h = cam.height;

    // Time tint
    const timeTint = TIME_TINTS[this.currentTime];
    if (timeTint.alpha > 0) {
      // Smooth transition: blend based on how far into the period we are
      const alpha = this.getSmoothedAlpha(timeTint.alpha);
      this.overlay.fillStyle(timeTint.color, alpha);
      this.overlay.fillRect(0, 0, w, h);
    }

    // Weather tint (additive)
    const weatherTint = WEATHER_TINTS[this.currentWeather];
    if (weatherTint.alpha > 0) {
      this.overlay.fillStyle(weatherTint.color, weatherTint.alpha);
      this.overlay.fillRect(0, 0, w, h);
    }
  }

  private getSmoothedAlpha(targetAlpha: number): number {
    // Smooth transitions at boundaries
    const h = this.gameHour;

    // Dawn transition (5-7): fade from night to dawn to day
    if (h >= DAWN_START && h < DAY_START) {
      const t = (h - DAWN_START) / (DAY_START - DAWN_START);
      // Blend from night alpha to dawn alpha to 0
      if (t < 0.5) {
        return Phaser.Math.Linear(TIME_TINTS.night.alpha, targetAlpha, t * 2);
      }
      return Phaser.Math.Linear(targetAlpha, 0, (t - 0.5) * 2);
    }

    // Dusk transition (18-20): fade from day to dusk to night
    if (h >= DUSK_START && h < NIGHT_START) {
      const t = (h - DUSK_START) / (NIGHT_START - DUSK_START);
      if (t < 0.5) {
        return Phaser.Math.Linear(0, targetAlpha, t * 2);
      }
      return Phaser.Math.Linear(targetAlpha, TIME_TINTS.night.alpha, (t - 0.5) * 2);
    }

    return targetAlpha;
  }

  private drawStars(): void {
    this.starsGfx.clear();

    // Only visible at night or dusk
    if (this.currentTime !== "night" && this.currentTime !== "dusk") return;

    const baseAlpha = this.currentTime === "night" ? 0.8 : 0.3;
    const time = Date.now() / 1000;

    for (const star of this.stars) {
      const twinkle = Math.sin(time * 2 + star.twinkleOffset) * 0.3 + 0.7;
      const alpha = baseAlpha * twinkle;
      this.starsGfx.fillStyle(0xffffff, alpha);
      this.starsGfx.fillRect(star.x, star.y, star.size, star.size);
    }
  }

  private drawMoon(): void {
    this.moonGfx.clear();
    if (this.currentTime !== "night" && this.currentTime !== "dusk") return;

    const alpha = this.currentTime === "night" ? 0.9 : 0.4;

    // Crescent moon
    const mx = 950;
    const my = 60;

    // Main circle
    this.moonGfx.fillStyle(0xf5f0c1, alpha);
    this.moonGfx.fillCircle(mx, my, 14);

    // Shadow circle to create crescent
    this.moonGfx.fillStyle(0x0a0a2a, alpha * 0.9);
    this.moonGfx.fillCircle(mx + 6, my - 3, 12);

    // Subtle glow
    this.moonGfx.fillStyle(0xf5f0c1, alpha * 0.1);
    this.moonGfx.fillCircle(mx, my, 24);
  }

  private drawRain(): void {
    this.rainGfx.clear();

    if (this.currentWeather !== "rain" && this.currentWeather !== "storm") return;

    const cam = this.scene.cameras.main;
    const w = cam.width;
    const h = cam.height;

    // Ensure we have enough rain drops
    const targetDrops = this.currentWeather === "storm" ? 200 : 100;
    while (this.rainDrops.length < targetDrops) {
      this.rainDrops.push({
        x: Math.random() * w,
        y: Math.random() * h,
        speed: 8 + Math.random() * 6,
        length: 4 + Math.random() * 8,
      });
    }
    // Remove excess
    while (this.rainDrops.length > targetDrops) {
      this.rainDrops.pop();
    }

    const isStorm = this.currentWeather === "storm";
    const windAngle = isStorm ? 0.3 : 0.1; // slight angle for wind

    for (const drop of this.rainDrops) {
      drop.y += drop.speed;
      drop.x += drop.speed * windAngle;

      // Reset when off screen
      if (drop.y > h) {
        drop.y = -drop.length;
        drop.x = Math.random() * w;
      }
      if (drop.x > w) {
        drop.x = 0;
      }

      const alpha = isStorm ? 0.4 : 0.25;
      this.rainGfx.lineStyle(1, 0x88aacc, alpha);
      this.rainGfx.lineBetween(
        drop.x,
        drop.y,
        drop.x + drop.length * windAngle,
        drop.y + drop.length
      );
    }
  }

  private drawLightning(): void {
    if (this.currentWeather !== "storm") return;

    // Random lightning flash
    if (Math.random() < 0.003) { // ~3% chance per tick (100ms)
      const cam = this.scene.cameras.main;
      const w = cam.width;
      const h = cam.height;

      // White flash
      this.overlay.fillStyle(0xffffff, 0.3);
      this.overlay.fillRect(0, 0, w, h);

      // Quick fade — the next tick will redraw normally
    }
  }

  private changeWeather(): void {
    const weathers: Weather[] = ["clear", "clear", "clear", "cloudy", "cloudy", "rain", "storm"];
    const newWeather = weathers[Math.floor(Math.random() * weathers.length)];

    if (newWeather !== this.currentWeather) {
      this.currentWeather = newWeather;

      // Clear rain drops when weather changes to non-rain
      if (newWeather !== "rain" && newWeather !== "storm") {
        this.rainDrops = [];
      }
    }
  }

  // ── Public API ──

  getTimeOfDay(): TimeOfDay {
    if (this.gameHour >= NIGHT_START || this.gameHour < DAWN_START) return "night";
    if (this.gameHour >= DUSK_START) return "dusk";
    if (this.gameHour >= DAY_START) return "day";
    return "dawn";
  }

  getWeather(): Weather {
    return this.currentWeather;
  }

  getGameHour(): number {
    return this.gameHour;
  }

  /** Force a specific weather (for testing or events) */
  setWeather(weather: Weather): void {
    this.currentWeather = weather;
    if (weather !== "rain" && weather !== "storm") {
      this.rainDrops = [];
    }
  }

  destroy(): void {
    this.overlay.destroy();
    this.starsGfx.destroy();
    this.moonGfx.destroy();
    this.rainGfx.destroy();
  }
}
