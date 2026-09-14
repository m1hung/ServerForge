export function PageTitle({ children }: { children: string }) {
  return (
    <h1 className="h1" aria-label={children}>
      {children.replace(/\.$/, '')}
      <span className="heading-dot" aria-hidden="true">
        .
      </span>
    </h1>
  );
}
