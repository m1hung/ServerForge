'use client';

import { useRef, useState } from 'react';
import type { Server } from '@/lib/servers';
import { displayName } from '@/lib/servers';
import { CopyButton } from './CopyButton';
import { Icon } from './Icon';

export function ConsoleCommands({
  server,
  canInsert,
  onInsert,
}: {
  server: Server;
  canInsert: boolean;
  onInsert: (command: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const glossary = server.console;
  if (!glossary?.canRead || !glossary.commands?.length) return null;
  const query = search.trim().toLowerCase();
  const commands = glossary.commands.filter((entry) =>
    `${entry.command} ${entry.summary} ${entry.category}`.toLowerCase().includes(query),
  );
  const categories = [...new Set(commands.map((entry) => entry.category))];

  return (
    <>
      <button
        className="btn secondary small"
        aria-haspopup="dialog"
        onClick={() => {
          setSearch('');
          dialog.current?.showModal();
          searchInput.current?.focus();
        }}
      >
        <Icon name="book" size={15} />
        Command cheat sheet
      </button>
      <dialog
        ref={dialog}
        className="tool-dialog command-sheet"
        aria-labelledby="command-sheet-title"
      >
        <header className="command-sheet-header">
          <div>
            <span className="eyebrow">{displayName(server.gameId)}</span>
            <h2 id="command-sheet-title">Command cheat sheet</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close command cheat sheet"
            onClick={() => dialog.current?.close()}
          >
            <Icon name="close" size={18} />
          </button>
        </header>
        <p>{glossary.note}</p>
        <p className="command-sheet-hint">
          {glossary.acceptsCommands
            ? 'Insert a command, edit its placeholders, then press Send when ready. Nothing runs when you insert it. Use help for commands added by mods or plugins.'
            : 'This console is log-only. Use the in-game commands or panel actions described below.'}{' '}
          <code>&lt;…&gt;</code> required · <code>[…]</code> optional
        </p>
        <label className="command-sheet-search">
          <span className="sr-only">Search commands</span>
          <Icon name="search" size={17} />
          <input
            ref={searchInput}
            type="search"
            placeholder="Search commands, players, world…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="command-sheet-list" role="region" tabIndex={0} aria-label="Command reference">
          {categories.map((category) => (
            <section key={category}>
              <h3>{category}</h3>
              <ul>
                {commands
                  .filter((entry) => entry.category === category)
                  .map((entry) => (
                    <li key={entry.command}>
                      <div>
                        <code>{entry.command}</code>
                        <p>{entry.summary}</p>
                      </div>
                      {glossary.acceptsCommands && canInsert ? (
                        <button
                          className="btn secondary small"
                          aria-label={`Insert ${entry.command}`}
                          onClick={() => {
                            dialog.current?.close();
                            onInsert(entry.command);
                          }}
                        >
                          Insert
                        </button>
                      ) : (
                        <CopyButton value={entry.command} />
                      )}
                    </li>
                  ))}
              </ul>
            </section>
          ))}
          {!commands.length && (
            <p role="status">No matching commands. Try a command name or category.</p>
          )}
        </div>
      </dialog>
    </>
  );
}
