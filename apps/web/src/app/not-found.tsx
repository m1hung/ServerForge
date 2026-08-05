import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="eyebrow">error 404</p>
      <h1 className="display text-xl">That page does not exist</h1>
      <p className="max-w-sm text-[13px] leading-relaxed text-ink-muted">
        The link may be out of date, or the server it pointed at was deleted.
      </p>
      <Link
        href="/servers"
        className="mt-1 rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink transition-colors hover:bg-accent/90"
      >
        Back to your servers
      </Link>
    </main>
  );
}
