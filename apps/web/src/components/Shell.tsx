'use client';

import { ProtectedLink as Link } from '@/components/UnsavedChanges';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { PageTitle } from './PageTitle';
import { api } from '@/lib/api';
import { usePreferences } from './Preferences';
import { useBrand } from './BrandProvider';
import { useNavigationGuard } from './UnsavedChanges';

type User = { username: string; displayName: string; role: string };
const UserContext = createContext<User | null>(null);
export const useCurrentUser = () => useContext(UserContext);

export function Shell({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const { dark: darkMode, update: updatePreferences } = usePreferences();
  const guide = useRef<HTMLDialogElement>(null);
  const firstNavLink = useRef<HTMLAnchorElement>(null);
  const menuToggle = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const pathname = usePathname();
  const brand = useBrand().name;
  const navigation = useNavigationGuard();
  const administrator = !!user && ['owner', 'admin'].includes(user.role);
  const restricted = ['/deploy', '/network', '/accounts', '/system'].includes(pathname);
  const page =
    pathname === '/network'
      ? 'Network & access'
      : pathname === '/deploy'
        ? 'Deploy a server'
        : pathname.startsWith('/servers/')
          ? 'Server details'
          : pathname === '/account'
            ? 'Account'
            : pathname === '/accounts'
              ? 'Workspace accounts'
              : pathname === '/system'
                ? 'System status'
                : 'Overview';

  useEffect(() => {
    api<{ user: User | null }>('/api/me')
      .then((data) => {
        setUser(data.user);
        if (!data.user) window.location.replace('/login');
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  function toggleDarkMode() {
    updatePreferences({ theme: darkMode ? 'light' : 'dark' });
  }

  function closeMenu() {
    setMenuOpen(false);
    requestAnimationFrame(() => menuToggle.current?.focus());
  }

  useEffect(() => {
    if (!menuOpen) return;
    firstNavLink.current?.focus();
    const desktop = window.matchMedia('(min-width: 701px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setMenuOpen(false);
    };
    desktop.addEventListener('change', closeOnDesktop);
    closeOnDesktop();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') {
        closeMenu();
      } else if (event.key === 'Tab') {
        const controls = [
          ...(sidebar.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ??
            []),
        ].filter((element) => element.getClientRects().length > 0);
        const first = controls[0],
          last = controls.at(-1);
        if (
          !sidebar.current?.contains(document.activeElement) ||
          (event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      desktop.removeEventListener('change', closeOnDesktop);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  async function logout() {
    setSigningOut(true);
    try {
      await api('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign out. Try again.');
      setSigningOut(false);
    }
  }

  return (
    <div className={`app-shell${pathname.startsWith('/servers/') ? ' server-shell' : ''}`}>
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      {menuOpen && (
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          aria-hidden="true"
          tabIndex={-1}
          onClick={closeMenu}
        />
      )}
      <aside
        ref={sidebar}
        id="sidebar"
        className={`sidebar ${menuOpen ? 'is-open' : ''}`}
        role={menuOpen ? 'dialog' : undefined}
        aria-modal={menuOpen || undefined}
        aria-label={menuOpen ? 'Workspace navigation' : undefined}
      >
        <button
          className="icon-button mobile-nav-close"
          aria-label="Close navigation"
          onClick={closeMenu}
        >
          <Icon name="close" size={18} />
        </button>
        <Link href="/" className="brand" onClick={() => setMenuOpen(false)}>
          <span className="brand-mark">
            <Icon name="server" size={21} />
          </span>
          {brand}
          <span className="brand-dot">.</span>
        </Link>
        <div className="workspace-label">
          <span className="workspace-avatar">P</span>
          <div>
            <strong>Personal workspace</strong>
            <span>Your infrastructure</span>
          </div>
          <span className="workspace-indicator" />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="main-nav" aria-label="Main navigation">
          <Link
            ref={firstNavLink}
            className={pathname === '/' ? 'active' : ''}
            aria-current={pathname === '/' ? 'page' : undefined}
            href="/"
            onClick={() => setMenuOpen(false)}
          >
            <Icon name="grid" />
            Overview
          </Link>
          <Link
            className={pathname.startsWith('/servers/') ? 'active' : ''}
            aria-current={pathname.startsWith('/servers/') ? 'page' : undefined}
            href="/#servers"
            onClick={() => setMenuOpen(false)}
          >
            <Icon name="server" />
            My servers
          </Link>
          {user && ['owner', 'admin'].includes(user.role) && (
            <Link
              className={pathname === '/deploy' ? 'active' : ''}
              aria-current={pathname === '/deploy' ? 'page' : undefined}
              href="/deploy"
              onClick={() => setMenuOpen(false)}
            >
              <Icon name="plus" />
              Deploy a server
            </Link>
          )}
          {user && ['owner', 'admin'].includes(user.role) && (
            <Link
              className={pathname === '/network' ? 'active' : ''}
              aria-current={pathname === '/network' ? 'page' : undefined}
              href="/network"
              onClick={() => setMenuOpen(false)}
            >
              <Icon name="network" />
              Network & access
            </Link>
          )}
          <Link
            className={pathname === '/account' ? 'active' : ''}
            aria-current={pathname === '/account' ? 'page' : undefined}
            href="/account"
            onClick={() => setMenuOpen(false)}
          >
            <Icon name="user" />
            Account
          </Link>
          {user && ['owner', 'admin'].includes(user.role) && (
            <Link
              className={pathname === '/accounts' ? 'active' : ''}
              aria-current={pathname === '/accounts' ? 'page' : undefined}
              href="/accounts"
              onClick={() => setMenuOpen(false)}
            >
              <Icon name="users" />
              Workspace accounts
            </Link>
          )}
          {user && ['owner', 'admin'].includes(user.role) && (
            <Link
              className={pathname === '/system' ? 'active' : ''}
              aria-current={pathname === '/system' ? 'page' : undefined}
              href="/system"
              onClick={() => setMenuOpen(false)}
            >
              <Icon name="activity" />
              System status
            </Link>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="note-icon">
              <Icon name="cube" />
            </span>
            <strong>Your world. Your rules.</strong>
            <p>A place for your next adventure, powered by you.</p>
            <Link href={administrator ? '/deploy' : '/'} onClick={() => setMenuOpen(false)}>
              {administrator ? 'Create a server' : 'Open your servers'}{' '}
              <Icon name="arrow" size={16} />
            </Link>
          </div>
          <button
            className="help-link theme-toggle"
            role="switch"
            aria-checked={darkMode}
            onClick={toggleDarkMode}
          >
            <Icon name={darkMode ? 'moon' : 'sun'} size={18} />
            Dark mode
            <span className="theme-switch" aria-hidden="true">
              <span />
            </span>
          </button>
          <button className="help-link" onClick={() => guide.current?.showModal()}>
            <Icon name="book" size={18} />
            Quick start guide
            <Icon name="chevron" size={14} />
          </button>
          <div className="profile">
            <span className="avatar">
              {(user?.displayName || user?.username || 'U').slice(0, 2).toUpperCase()}
            </span>
            <div>
              <strong>{user?.displayName || user?.username || 'Your account'}</strong>
              <span>{user?.role || 'Workspace member'}</span>
            </div>
            <button
              className="icon-button"
              title="Sign out"
              aria-label="Sign out"
              disabled={signingOut}
              onClick={() => navigation.request(null, () => void logout())}
            >
              <Icon name="logout" size={18} />
            </button>
          </div>
        </div>
      </aside>
      <div className="workspace" inert={menuOpen}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              ref={menuToggle}
              className="icon-button mobile-menu"
              aria-label="Toggle navigation"
              aria-controls="sidebar"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Icon name="menu" />
            </button>
            <span>Workspace</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{page}</strong>
          </div>
          <span className="hosting-label">
            <Icon name="shield" size={15} />
            Self-hosted
            <span className="hosting-dot" />
          </span>
        </header>
        <main id="main" className="page" tabIndex={-1}>
          {error && (
            <div className="error-banner" role="alert">
              <Icon name="alert" />
              {error}
            </div>
          )}
          {!user ? (
            <p className="muted" role="status">
              {error
                ? 'Your workspace could not be loaded. Reload to try again.'
                : 'Loading your workspace…'}
            </p>
          ) : restricted && !administrator ? (
            <section className="card empty-state">
              <PageTitle>Administrator access required</PageTitle>
              <p className="muted">
                Ask your workspace owner to manage this setting. You can use the features shared
                with you on your server page.
              </p>
              <Link className="btn" href="/">
                Back to your servers
              </Link>
            </section>
          ) : (
            <UserContext.Provider value={user}>{children}</UserContext.Provider>
          )}
        </main>
        <footer className="workspace-footer">
          <span>
            {brand} <span className="footer-dot">·</span> Built for your next adventure.
          </span>
          <span>
            <Icon name="shield" size={13} />
            Your servers. Under your control.
          </span>
        </footer>
      </div>
      <dialog ref={guide} className="guide-dialog" aria-labelledby="guide-title">
        <div className="section-heading">
          <span className="eyebrow">GETTING STARTED</span>
          <button
            className="icon-button"
            aria-label="Close guide"
            onClick={() => guide.current?.close()}
          >
            <Icon name="close" />
          </button>
        </div>
        <h2 id="guide-title">From setup to game night.</h2>
        <ol className="guide-steps">
          <li>
            <strong>Choose your game</strong>
            <p>
              Pick a game and edition, then give your server a name. Resource limits use the
              edition’s recommended defaults.
            </p>
          </li>
          <li>
            <strong>Let it install</strong>
            <p>
              Open your server to follow its status. It will be offline when installation finishes.
            </p>
          </li>
          <li>
            <strong>Start and connect</strong>
            <p>
              Start the server, then copy its join address into your game. Use the console to send
              supported commands.
            </p>
          </li>
        </ol>
        <details className="settings-details">
          <summary>Explore the server tools</summary>
          <ul className="guide-features">
            <li>
              <strong>Settings:</strong> change game rules and hardware. Save, then restart to
              apply.
            </li>
            <li>
              <strong>Mods & plugins:</strong> upload compatible files while the game is stopped.
              For a CurseForge server pack ZIP, choose that edition when deploying.
            </li>
            <li>
              <strong>Backups & restore:</strong> save a recovery point before changing a world or
              its mods.
            </li>
            <li>
              <strong>Schedules & alerts:</strong> automate backups and restarts, or set up
              server-event notifications.
            </li>
            <li>
              <strong>Files and updates:</strong> edit server files, prepare game updates, and
              review changes before applying.
            </li>
            <li>
              <strong>Shared access:</strong> give another dashboard account permission to help
              manage a server. Use Share for player join addresses.
            </li>
          </ul>
          <p className="muted">
            You’ll see the tools your account can use. Ask the server owner for additional
            permissions.
          </p>
        </details>
        <Link
          className="btn"
          href={administrator ? '/deploy' : '/'}
          onClick={() => guide.current?.close()}
        >
          {administrator ? 'Deploy a server' : 'Open your servers'}
          <Icon name="arrow" size={16} />
        </Link>
      </dialog>
    </div>
  );
}
