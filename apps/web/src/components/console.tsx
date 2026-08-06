'use client';

import { ArrowDown, BookOpen, Send, Terminal, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button, Input } from '@/components/ui';
import type { ConsoleLine } from '@/hooks/use-server-stream';

/**
 * The console.
 *
 * Two behaviours make or break this component:
 *   1. Auto-scroll that yields the moment the user scrolls up to read
 *      something, and offers an explicit way back down.
 *   2. Command history on arrow keys, because operators expect a terminal to
 *      behave like a terminal.
 *
 * The glossary is adapter-driven: Minecraft lists stdin commands you can
 * click-to-insert; Palworld/Valheim explain that this pane is logs-only and
 * still show in-game admin references.
 */

export interface ConsoleCommandEntry {
  command: string;
  summary: string;
  category: string;
}

export interface ConsoleGlossary {
  acceptsCommands: boolean;
  note?: string;
  commands: ConsoleCommandEntry[];
}

const LEVEL_PATTERNS: { pattern: RegExp; className: string }[] = [
  { pattern: /\b(ERROR|SEVERE|FATAL)\b|Exception|Caused by:/i, className: 'text-danger' },
  { pattern: /\bWARN(ING)?\b/i, className: 'text-warn' },
  { pattern: /Done \([\d.]+s\)!|joined the game/i, className: 'text-ok' },
];

function classify(text: string, stream: string): string {
  if (stream === 'system') return 'text-info italic';
  for (const { pattern, className } of LEVEL_PATTERNS) {
    if (pattern.test(text)) return className;
  }
  return 'text-ink-muted';
}

/** Prefer the part before the first placeholder so insert leaves the cursor useful. */
function insertableCommand(command: string): string {
  const cut = command.search(/[<[]/);
  return (cut === -1 ? command : command.slice(0, cut)).trimEnd();
}

export function Console({
  lines,
  connected,
  canSend,
  onSend,
  disabledReason,
  glossary,
}: {
  lines: ConsoleLine[];
  connected: boolean;
  canSend: boolean;
  onSend: (command: string) => void;
  disabledReason?: string;
  glossary?: ConsoleGlossary | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pinned, setPinned] = useState(true);
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [filter, setFilter] = useState('');
  const [glossaryOpen, setGlossaryOpen] = useState(false);

  const acceptsCommands = glossary?.acceptsCommands !== false;
  const sendEnabled = canSend && acceptsCommands;

  const filtered = useMemo(() => {
    if (filter.trim() === '') return lines;
    const needle = filter.toLowerCase();
    return lines.filter((line) => line.text.toLowerCase().includes(needle));
  }, [lines, filter]);

  const grouped = useMemo(() => {
    if (!glossary?.commands.length) return [];
    const map = new Map<string, ConsoleCommandEntry[]>();
    for (const entry of glossary.commands) {
      const list = map.get(entry.category) ?? [];
      list.push(entry);
      map.set(entry.category, list);
    }
    return [...map.entries()];
  }, [glossary]);

  useEffect(() => {
    if (!pinned) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [filtered, pinned]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    // 40px of slack: an exact comparison unpins on sub-pixel scroll jitter.
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    setPinned(atBottom);
  };

  const submit = () => {
    const trimmed = command.trim();
    if (trimmed === '' || !sendEnabled) return;
    onSend(trimmed);
    setHistory((h) => [trimmed, ...h.filter((c) => c !== trimmed)].slice(0, 50));
    setHistoryIndex(-1);
    setCommand('');
    setPinned(true);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.min(historyIndex + 1, history.length - 1);
      if (next >= 0 && history[next]) {
        setHistoryIndex(next);
        setCommand(history[next]!);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setCommand(next >= 0 ? (history[next] ?? '') : '');
    }
  };

  const pickCommand = (entry: ConsoleCommandEntry) => {
    if (!acceptsCommands) return;
    setCommand(insertableCommand(entry.command));
    setGlossaryOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const placeholder = !canSend
    ? (disabledReason ?? 'Start the server to send commands')
    : !acceptsCommands
      ? 'This game does not accept typed console commands'
      : 'Type a command and press Enter';

  return (
    /*
     * `relative` anchors the "jump to latest" button, which otherwise
     * positions itself against whatever ancestor happens to be positioned.
     */
    <div className="panel relative flex h-full min-h-0 flex-col overflow-hidden p-1.5">
      <div className="flex items-center gap-3 px-2 py-1.5">
        <Terminal className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
        <span className="legend">console</span>

        <span
          className={cn(
            'inline-flex items-center gap-1.5 text-[11.5px] font-medium leading-none',
            connected ? 'text-ok' : 'text-warn',
          )}
        >
          <span
            className={cn('lamp h-[6px] w-[6px]', connected && 'animate-blink')}
            aria-hidden
          />
          {connected ? 'Live' : 'Reconnecting…'}
        </span>

        {glossary && glossary.commands.length > 0 && (
          <Button
            type="button"
            variant={glossaryOpen ? 'primary' : 'secondary'}
            size="sm"
            className="ml-1 h-7"
            onClick={() => setGlossaryOpen((open) => !open)}
            aria-expanded={glossaryOpen}
            aria-controls="console-glossary"
          >
            <BookOpen className="h-3.5 w-3.5" aria-hidden />
            Commands
          </Button>
        )}

        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter output"
          aria-label="Filter console output"
          className="ml-auto h-7 max-w-44 text-[12px]"
        />
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          role="log"
          aria-label="Server console output"
          aria-live="polite"
          className="console inset-well relative min-h-0 flex-1 overflow-y-auto scrollbar-thin px-3 py-2.5"
        >
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-[12.5px] text-ink-subtle">
              {lines.length === 0
                ? 'Nothing yet. Output appears here as soon as the server starts.'
                : 'No lines match that filter.'}
            </p>
          ) : (
            // Position is part of the key because a server restart resets the
            // sequence counter, and two lines can share a millisecond — neither
            // seq nor timestamp is unique on its own. The list is append-only,
            // so index is stable.
            filtered.map((line, index) => (
              <div
                key={`${line.at}-${line.seq}-${index}`}
                className="flex gap-3 whitespace-pre-wrap break-words px-1 hover:bg-surface/50"
              >
                <span className="shrink-0 select-none tabular-nums text-ink-subtle/60">
                  {new Date(line.at).toLocaleTimeString([], { hour12: false })}
                </span>
                <span className={classify(line.text, line.stream)}>{line.text}</span>
              </div>
            ))
          )}
        </div>

        {glossaryOpen && glossary && (
          <aside
            id="console-glossary"
            className="absolute inset-y-0 right-0 z-20 flex w-full max-w-sm flex-col border-l border-line bg-surface-raised shadow-overlay md:w-[22rem]"
          >
            <div className="flex items-start gap-2 border-b border-line px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-medium text-ink">Command glossary</p>
                {glossary.note && (
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">{glossary.note}</p>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close command glossary"
                onClick={() => setGlossaryOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-2 py-2">
              {grouped.map(([category, entries]) => (
                <div key={category} className="mb-3">
                  <p className="legend px-2 py-1">{category}</p>
                  <ul className="space-y-0.5">
                    {entries.map((entry) => {
                      const clickable = acceptsCommands;
                      return (
                        <li key={`${category}-${entry.command}`}>
                          <button
                            type="button"
                            disabled={!clickable}
                            onClick={() => pickCommand(entry)}
                            title={
                              clickable
                                ? 'Insert into the command box'
                                : 'Reference only — not sent from this console'
                            }
                            className={cn(
                              'w-full rounded-md px-2 py-1.5 text-left transition-colors',
                              clickable
                                ? 'hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
                                : 'cursor-default opacity-90',
                            )}
                          >
                            <code className="block font-mono text-[12px] text-accent">
                              {entry.command}
                            </code>
                            <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-muted">
                              {entry.summary}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>

      {!pinned && (
        <button
          type="button"
          onClick={() => {
            setPinned(true);
            const element = scrollRef.current;
            if (element) element.scrollTop = element.scrollHeight;
          }}
          className="absolute bottom-[4.5rem] left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface-raised px-3 py-1.5 text-[12px] shadow-overlay"
        >
          <ArrowDown className="h-3.5 w-3.5" aria-hidden />
          Jump to latest
        </button>
      )}

      <div className="px-2 pb-1 pt-2.5">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {/* The prompt glyph belongs to the form, not the input, so it never
              collides with the placeholder or the caret. */}
          <span
            className={cn(
              'shrink-0 select-none pl-0.5 font-mono text-[13px]',
              sendEnabled ? 'text-accent' : 'text-ink-subtle',
            )}
            aria-hidden
          >
            ›
          </span>
          <Input
            ref={inputRef}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={!sendEnabled}
            placeholder={placeholder}
            aria-label="Console command"
            className="border-transparent bg-transparent px-1 text-[13px] focus:bg-transparent"
          />
          <Button
            type="submit"
            variant="secondary"
            size="icon"
            disabled={!sendEnabled}
            aria-label="Send command"
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
