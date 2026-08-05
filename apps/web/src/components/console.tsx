'use client';

import { ArrowDown, Send, Terminal } from 'lucide-react';
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
 */

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

export function Console({
  lines,
  connected,
  canSend,
  onSend,
  disabledReason,
}: {
  lines: ConsoleLine[];
  connected: boolean;
  canSend: boolean;
  onSend: (command: string) => void;
  disabledReason?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    if (filter.trim() === '') return lines;
    const needle = filter.toLowerCase();
    return lines.filter((line) => line.text.toLowerCase().includes(needle));
  }, [lines, filter]);

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
    if (trimmed === '' || !canSend) return;
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

        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter output"
          aria-label="Filter console output"
          className="ml-auto h-7 max-w-44 text-[12px]"
        />
      </div>

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
              canSend ? 'text-accent' : 'text-ink-subtle',
            )}
            aria-hidden
          >
            ›
          </span>
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={!canSend}
            placeholder={canSend ? 'Type a command and press Enter' : (disabledReason ?? 'Start the server to send commands')}
            aria-label="Console command"
            className="border-transparent bg-transparent px-1 text-[13px] focus:bg-transparent"
          />
          <Button type="submit" variant="secondary" size="icon" disabled={!canSend} aria-label="Send command">
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
