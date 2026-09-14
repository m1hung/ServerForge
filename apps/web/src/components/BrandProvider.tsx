'use client';
import { createContext, useContext, type ReactNode } from 'react';

export type DisplayBrand = { name: string; tagline: string; accent: string };
const Branding = createContext<DisplayBrand>({
  name: 'ServerForge',
  tagline: 'Launch a game server in minutes, not hours.',
  accent: '#f97316',
});
export const useBrand = () => useContext(Branding);
export function BrandProvider({ value, children }: { value: DisplayBrand; children: ReactNode }) {
  return <Branding.Provider value={value}>{children}</Branding.Provider>;
}
