'use client';

import type { ReactNode } from 'react';
import { ProtectedLink as Link } from '@/components/UnsavedChanges';
import { Icon } from './Icon';
import { PageTitle } from './PageTitle';
import { useBrand } from './BrandProvider';

export function AuthLayout({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const brand = useBrand().name;
  return (
    <main className="login-page">
      <section className="login-brand-panel" aria-label="About this workspace">
        <Link href="/" className="brand">
          <span className="brand-mark">
            <Icon name="server" size={24} />
          </span>
          {brand}
          <span className="brand-dot">.</span>
        </Link>
        <div>
          <div className="eyebrow">YOUR WORLD. YOUR RULES.</div>
          <h2>
            Good times.
            <br />
            Great company.
            <br />
            Your own server.
          </h2>
          <p>A home for your community and a launchpad for your next adventure.</p>
        </div>
        <span>Self-hosted. Under your control.</span>
      </section>
      <section className="login-form-panel" aria-label={title}>
        <div className="login-form">
          <div className="eyebrow">{eyebrow}</div>
          <PageTitle>{title}</PageTitle>
          <p className="muted">{description}</p>
          {children}
        </div>
      </section>
    </main>
  );
}
