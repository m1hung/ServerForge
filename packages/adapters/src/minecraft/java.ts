import { compareMinecraftVersions } from './versions.js';

/**
 * JVM tuning.
 *
 * Beginners should never see a flag. They pick "Balanced" and get a heap
 * sized from their memory limit plus a GC configuration that does not
 * stutter. Advanced users get Aikar's flags or a free-text box.
 */

export type JavaFlagsPreset = 'balanced' | 'aikar' | 'minimal' | 'custom';

/**
 * Heap is capped below the container limit: the JVM needs headroom for
 * metaspace, code cache, GC structures, thread stacks and direct buffers.
 * Undersizing this is the single most common cause of a container being
 * OOM-killed with no Java error in the log — which reads as "my server just
 * died" to the user.
 */
export function heapForMemoryLimit(memoryMib: number): number {
  if (memoryMib <= 0) return 1024;
  const overhead = Math.max(512, Math.min(1536, Math.round(memoryMib * 0.15)));
  return Math.max(512, memoryMib - overhead);
}

export function buildJavaFlags(options: {
  preset: JavaFlagsPreset;
  memoryMib: number;
  custom?: string | null;
}): string[] {
  const heap = heapForMemoryLimit(options.memoryMib);
  const memoryFlags = [`-Xms${Math.min(heap, 1024)}M`, `-Xmx${heap}M`];

  switch (options.preset) {
    case 'minimal':
      return memoryFlags;

    case 'custom':
      return [...memoryFlags, ...tokenizeFlags(options.custom ?? '')];

    case 'aikar':
      // Aikar's flags: G1 tuned for Minecraft's allocation pattern.
      // Region size scales with heap; large heaps want 16M regions.
      return [
        ...memoryFlags,
        '-XX:+UseG1GC',
        '-XX:+ParallelRefProcEnabled',
        '-XX:MaxGCPauseMillis=200',
        '-XX:+UnlockExperimentalVMOptions',
        '-XX:+DisableExplicitGC',
        '-XX:+AlwaysPreTouch',
        '-XX:G1NewSizePercent=30',
        '-XX:G1MaxNewSizePercent=40',
        `-XX:G1HeapRegionSize=${heap >= 12288 ? 16 : 8}M`,
        '-XX:G1ReservePercent=20',
        '-XX:G1HeapWastePercent=5',
        '-XX:G1MixedGCCountTarget=4',
        '-XX:InitiatingHeapOccupancyPercent=15',
        '-XX:G1MixedGCLiveThresholdPercent=90',
        '-XX:G1RSetUpdatingPauseTimePercent=5',
        '-XX:SurvivorRatio=32',
        '-XX:+PerfDisableSharedMem',
        '-XX:MaxTenuringThreshold=1',
        '-Dusing.aikars.flags=https://mcflags.emc.gs',
        '-Daikars.new.flags=true',
      ];

    case 'balanced':
    default:
      // Modern G1 defaults with a pause target. Safe on every heap size and
      // materially better than the JVM defaults for a tick-based workload.
      return [
        ...memoryFlags,
        '-XX:+UseG1GC',
        '-XX:MaxGCPauseMillis=130',
        '-XX:+ParallelRefProcEnabled',
        '-XX:+AlwaysPreTouch',
        '-XX:+DisableExplicitGC',
        '-XX:+PerfDisableSharedMem',
      ];
  }
}

/**
 * Splits a user-supplied flag string the way a shell would.
 *
 * Quotes group, they do not delimit: `-Dmotd="hello world"` is one argument,
 * not two. A regex alternation gets this wrong because the unquoted branch
 * happily consumes the opening quote, so this walks the string instead.
 */
export function tokenizeFlags(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const char of input) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }

    current += char;
    started = true;
  }

  if (started) tokens.push(current);
  return tokens;
}

/**
 * Fallback JRE major for a Minecraft version.
 *
 * This is a *guess*, used only when the authoritative answer is unavailable.
 * Mojang publishes `javaVersion.majorVersion` per version, and the installer
 * records it on the server — see `detectRuntime` in the adapter. Prefer that
 * value; getting this wrong produces either `UnsupportedClassVersionError` or
 * a flat refusal to boot, neither of which means anything to a first-time host.
 *
 * Minecraft switched from `1.x` to calendar-style versions (`26.1`, `26.2`) in
 * 2026, so a leading major of 2 or more denotes the new scheme and is always
 * newer than any `1.x` release.
 */
export function javaMajorFor(minecraftVersion: string, loader?: string): number {
  if (isCalendarVersion(minecraftVersion)) {
    // 26.1 was the first release to require Java 25.
    return 25;
  }

  // Forge on 1.16 and below is unhappy on anything past Java 8.
  if (compareMinecraftVersions(minecraftVersion, '1.17') < 0) return 8;
  if (compareMinecraftVersions(minecraftVersion, '1.18') < 0) return 16;
  if (compareMinecraftVersions(minecraftVersion, '1.20.5') < 0) return 17;
  // Forge lags behind on new JDKs; 21 is the safe ceiling for the 1.x line.
  if (loader === 'forge') return 21;
  return 21;
}

/**
 * True for the post-2026 calendar versioning ("26.2"), false for classic
 * "1.21.4". Everything before the switch starts with "1.".
 */
export function isCalendarVersion(version: string): boolean {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= 2;
}

/** JRE majors we ship an image for, newest last. */
const AVAILABLE_JRES = [8, 11, 17, 21, 25] as const;

export function javaImageFor(majorVersion: number): string {
  // Round *up* to the next available JRE: running on a newer JVM than required
  // is normally fine, running on an older one never is.
  const tag = AVAILABLE_JRES.find((jre) => jre >= majorVersion) ?? AVAILABLE_JRES[AVAILABLE_JRES.length - 1];
  return `eclipse-temurin:${tag}-jre-jammy`;
}
