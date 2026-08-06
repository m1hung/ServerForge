import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadManifestsFrom } from '../packages/adapters/src/manifest/load.js';
import { valheimManifest } from '../packages/adapters/src/manifest/games/valheim.js';
import type { GameManifest } from '../packages/adapters/src/manifest/types.js';
import type { GameAdapter } from '../packages/adapters/src/types.js';

/**
 * The games directory loader.
 *
 * Driven against a real temporary directory rather than a mocked filesystem:
 * the failure this guards against is a manifest that is fine in isolation and
 * unreadable on disk, and a mock cannot tell you about that.
 *
 * The registry is injected rather than global, so these tests neither depend
 * on nor disturb the built-in games.
 */

/** Stand-in registry with the same duplicate-id rule as the real one. */
function makeRegistry(existing: string[] = []) {
  const ids = new Set(existing);
  return {
    ids,
    register(adapter: GameAdapter) {
      if (ids.has(adapter.id)) {
        throw new Error(
          `"${adapter.id}" is already a game this panel ships with. Change the "id" in your manifest to something else.`,
        );
      }
      ids.add(adapter.id);
    },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-games-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** A valid manifest under a different id, so it never collides by accident. */
function exampleManifest(id: string): GameManifest {
  return { ...(JSON.parse(JSON.stringify(valheimManifest)) as GameManifest), id };
}

async function write(name: string, contents: unknown): Promise<void> {
  await fs.writeFile(
    path.join(dir, name),
    typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2),
  );
}

function load(registry: ReturnType<typeof makeRegistry>, target = dir) {
  return loadManifestsFrom(target, { register: registry.register.bind(registry) });
}

describe('games directory loader', () => {
  it('returns nothing when the directory does not exist', async () => {
    const result = await load(makeRegistry(), path.join(dir, 'nope'));
    expect(result).toEqual({ loaded: [], failed: [] });
  });

  it('loads a valid manifest and registers it', async () => {
    await write('example.json', exampleManifest('example'));

    const registry = makeRegistry();
    const result = await load(registry);

    expect(result.failed).toEqual([]);
    expect(result.loaded).toEqual([{ id: 'example', file: 'example.json' }]);
    expect(registry.ids.has('example')).toBe(true);
  });

  it('ignores files that are not .json', async () => {
    await write('notes.txt', 'nothing to see');
    await write('example.json', exampleManifest('example'));

    const result = await load(makeRegistry());
    expect(result.loaded.map((entry) => entry.file)).toEqual(['example.json']);
  });

  /**
   * The central promise: one bad file costs you that game, not the panel.
   * Refusing to start would take management of every running server with it.
   */
  it('skips a broken manifest and still loads the good ones', async () => {
    await write('aaa-broken.json', '{ not json at all');
    await write('bbb-good.json', exampleManifest('good-one'));

    const result = await load(makeRegistry());

    expect(result.loaded).toEqual([{ id: 'good-one', file: 'bbb-good.json' }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.file).toBe('aaa-broken.json');
    expect(result.failed[0]!.message).toMatch(/not valid JSON/);
  });

  it('reports every problem in an invalid manifest, not just the first', async () => {
    const manifest = exampleManifest('broken');
    manifest.runtime.command = ['{{setting.Nope}}', '{{port.nope}}'];
    await write('broken.json', manifest);

    const result = await load(makeRegistry());

    expect(result.loaded).toEqual([]);
    expect(result.failed[0]!.message).toMatch(/setting "Nope"/);
    expect(result.failed[0]!.message).toMatch(/port "nope"/);
  });

  it('refuses a manifest whose id collides with a built-in game', async () => {
    // The likely cause is a file copied from an example whose id was never
    // changed. Shadowing silently would look like the panel losing a game.
    await write('valheim.json', exampleManifest('valheim'));

    const result = await load(makeRegistry(['minecraft-java', 'palworld', 'valheim']));

    expect(result.loaded).toEqual([]);
    expect(result.failed[0]!.message).toMatch(/already a game this panel ships with/);
  });

  it('refuses the second of two manifests sharing an id, keeping the first', async () => {
    await write('a.json', exampleManifest('duplicate'));
    await write('b.json', exampleManifest('duplicate'));

    const result = await load(makeRegistry());

    expect(result.loaded).toEqual([{ id: 'duplicate', file: 'a.json' }]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.file).toBe('b.json');
  });

  it('reads files in a stable order so a collision fails the same way each boot', async () => {
    await write('z.json', exampleManifest('zed'));
    await write('a.json', exampleManifest('ay'));

    const result = await load(makeRegistry());
    expect(result.loaded.map((entry) => entry.file)).toEqual(['a.json', 'z.json']);
  });

  it('rejects a JSON array, which is the shape of a file holding several games', async () => {
    await write('list.json', [exampleManifest('one'), exampleManifest('two')]);

    const result = await load(makeRegistry());
    expect(result.failed[0]!.message).toMatch(/single JSON object describing one game/);
  });

  it('round-trips a built-in manifest through JSON unchanged', async () => {
    // Built-ins are TypeScript and operator manifests are JSON. If the format
    // could not survive that trip, the docs would be telling people to write
    // something the loader cannot read.
    await write('roundtrip.json', { ...valheimManifest, id: 'valheim-copy' });

    const registry = makeRegistry();
    const result = await load(registry);

    expect(result.failed).toEqual([]);
    expect(result.loaded).toEqual([{ id: 'valheim-copy', file: 'roundtrip.json' }]);
  });

  it('registers a loaded game into the real registry by default', async () => {
    // The default path has no injected registry — this is the one test that
    // proves the wiring, rather than the loop.
    const { getAdapter } = await import('../packages/adapters/src/registry.js');
    await write('realreg.json', exampleManifest('loader-smoke-test'));

    const result = await loadManifestsFrom(dir);

    expect(result.failed).toEqual([]);
    expect(getAdapter('loader-smoke-test').name).toBe(valheimManifest.name);
  });
});
