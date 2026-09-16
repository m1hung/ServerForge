import type { CSSProperties } from 'react';

const paths = {
  star: 'm12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9z',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
  user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2',
  users:
    'M14 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M2 21v-2a8 8 0 0 1 16 0v2 M18 4a4 4 0 0 1 0 8 M21 21v-3a6 6 0 0 0-3-5',
  network: 'M8 3h8v6H8z M12 9v5 M4 14h16 M4 14v3 M20 14v3 M1 17h6v5H1z M17 17h6v5h-6z',
  share:
    'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M8.6 10.5l6.8-4 M8.6 13.5l6.8 4',
  qr: 'M3 3h6v6H3z M15 3h6v6h-6z M3 15h6v6H3z M15 15h2v2h-2z M21 15v6h-6 M12 3v3 M3 12h3 M12 12h9 M12 18v3',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  server:
    'M5 3h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M5 13h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z M7 7h.01 M7 17h.01 M11 7h6 M11 17h6',
  plus: 'M12 5v14 M5 12h14',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  chevron: 'm9 5 7 7-7 7',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6.1 6.1A8 8 0 0 1 20 12 M4 12a8 8 0 0 0 13.9 5.9',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  cpu: 'M7 7h10v10H7z M10 10h4v4h-4z M9 3v4 M15 3v4 M9 17v4 M15 17v4 M3 9h4 M3 15h4 M17 9h4 M17 15h4',
  memory: 'M3 6h18v12H3z M7 10v4 M12 10v4 M17 10v4 M7 18v3 M12 18v3 M17 18v3',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  book: 'M12 5v16 M12 5C8 2 5 3 2 4v15c3-1 6-2 10 1 4-3 7-2 10-1V4c-3-1-6-2-10 1z',
  logout: 'M9 4H4v16h5 M9 12h12 M16 7l5 5-5 5',
  close: 'm6 6 12 12 M6 18 18 6',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  moon: 'M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13z',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  cube: 'm12 3 9 5v9l-9 5-9-5V8z M3 8l9 5 9-5 M12 13v9 M7.5 5.5l9 5',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18',
  check: 'm5 12 4 4L19 6',
  alert: 'm12 3 10 18H2z M12 9v5 M12 17h.01',
  play: 'm7 4 14 8-14 8z',
  stop: 'M5 5h14v14H5z',
  terminal: 'm4 5 6 6-6 6 M12 19h8',
  copy: 'M9 9h12v12H9z M15 5V3H3v12h2',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z m-4 9 3 3 5-6',
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 20,
  className,
  style,
}: {
  name: keyof typeof paths;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
