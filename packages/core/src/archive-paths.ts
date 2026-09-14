import path from 'node:path';
import { safeExtractTarget } from './paths.js';

export type ArchivePath = { path: string; type: string; linkpath?: string };
const nameOf = (name: string) => path.posix.normalize(name).replace(/\/$/, '') || '.';

/** Make a game's absolute container-local link portable without following it. */
export function portableGameLink(entry: string, target: string, gamePrefix = ''): string {
  if (!target.startsWith('/home/container/')) return target;
  safeExtractTarget('/game', target.slice('/home/container/'.length));
  return path.posix.relative(path.posix.dirname(nameOf(entry)), path.posix.join(gamePrefix, target.slice('/home/container/'.length))) || '.';
}

/** Validate the complete link graph before extracting anything. */
export function validateArchivePaths(entries: ArchivePath[]): void {
  const files = new Map<string, ArchivePath>();
  for (const entry of entries) {
    safeExtractTarget('/archive', entry.path);
    if (entry.path.includes('\\') || !['File', 'Directory', 'SymbolicLink', 'Link'].includes(entry.type))
      throw new Error('Archive contains an unsupported path or special file.');
    const name = nameOf(entry.path);
    if (files.has(name) && !(entry.type === 'Directory' && files.get(name)?.type === 'Directory'))
      throw new Error('Archive contains duplicate file paths.');
    files.set(name, entry);
  }
  const links = new Map([...files].filter(([, entry]) => ['SymbolicLink', 'Link'].includes(entry.type)));
  for (const [name, entry] of links) {
    if (name === '.' || !entry.linkpath || entry.linkpath.includes('\\') || entry.linkpath.includes('\0') || path.posix.isAbsolute(entry.linkpath) || /^[a-z]:/i.test(entry.linkpath))
      throw new Error('Archive link must have a relative, contained target.');
  }
  // Never write an archive entry through another entry's link, regardless of order.
  for (const name of files.keys()) {
    let parent = path.posix.dirname(name);
    while (parent !== '.') {
      if (links.has(parent)) throw new Error('Archive entry has a link as its parent.');
      parent = path.posix.dirname(parent);
    }
  }
  function resolve(input: string): string {
    const stack: string[] = [], remaining = input.split('/');
    let followed = 0;
    while (remaining.length) {
      const part = remaining.shift()!;
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!stack.length) throw new Error('Archive link escapes its destination.');
        stack.pop(); continue;
      }
      const linked = links.get([...stack, part].join('/'));
      if (!linked) { stack.push(part); continue; }
      if (++followed > 40) throw new Error('Archive link cycle or excessive link depth.');
      if (linked.type === 'Link') stack.length = 0; // Hard-link targets are archive-relative.
      remaining.unshift(...linked.linkpath!.split('/'));
    }
    return stack.join('/') || '.';
  }
  for (const [name, entry] of links) {
    const target = resolve(name);
    if (entry.type === 'Link' && files.get(target)?.type !== 'File')
      throw new Error('Archive hard link must resolve to a regular archived file.');
  }
}
