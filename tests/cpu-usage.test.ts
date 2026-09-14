// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ResourceUsage } from '@serverforge/core';
import { CpuUsage } from '../apps/web/src/components/CpuUsage';

const reading: ResourceUsage = {
  cpuPercent: 250,
  cpuLimitCores: 4,
  cpuHostCores: 8,
  cpuPerCorePercent: null,
  timestamp: 0,
  memoryBytes: 1024,
  memoryLimitBytes: 4096,
  diskBytes: null,
  networkRxBytes: 0,
  networkTxBytes: 0,
  uptimeSeconds: 10,
};
function render(usage: ResourceUsage | undefined, configuredCores = 4) {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(createElement(CpuUsage, { usage, configuredCores }));
  return container;
}

describe('CPU core visualization', () => {
  it('shows 250% as 2.5 core equivalents and clearly identifies the aggregate fallback', () => {
    const view = render(reading);
    expect(view.textContent).toContain('2.5of 4 cores');
    expect(view.textContent).toContain('62.5% of allocation');
    expect(view.textContent).toContain('Individual core readings aren’t available');
    expect(view.querySelectorAll('[role="meter"]')).toHaveLength(0);
    expect(
      [...view.querySelectorAll<HTMLElement>('.cpu-capacity-block')].map((el) =>
        el.style.getPropertyValue('--core-fill'),
      ),
    ).toEqual(['100%', '100%', '50%', '0%']);
  });
  it('shows independent measured cores on the same 0–100% scale', () => {
    const view = render({ ...reading, cpuPerCorePercent: [85, 75, 60, 30] });
    expect(
      [...view.querySelectorAll('[role="meter"]')].map((el) => el.getAttribute('aria-valuenow')),
    ).toEqual(['85', '75', '60', '30']);
    expect(view.textContent).toContain('Core 185%');
    expect(view.textContent).not.toContain('Individual core readings aren’t available');
  });
  it('uses the active fractional allocation until a restart and shows the partial block', () => {
    const view = render({ ...reading, cpuPercent: 75, cpuLimitCores: 1.5 }, 4);
    expect(view.textContent).toContain('0.75of 1.5 cores');
    expect(view.textContent).toContain('50% of allocation');
    expect(view.textContent).toContain('saved allocation applies on the next restart');
    expect(
      [...view.querySelectorAll<HTMLElement>('.cpu-capacity-block')].map((el) =>
        el.style.getPropertyValue('--core-capacity'),
      ),
    ).toEqual(['100%', '50%']);
  });
  it('handles an unlimited allocation and offline readings without inventing zero core usage', () => {
    const unlimited = render({ ...reading, cpuLimitCores: 0 }, 0);
    expect(unlimited.textContent).toContain('No CPU limit');
    expect(unlimited.querySelectorAll('.cpu-capacity-block')).toHaveLength(8);
    const offline = render(undefined);
    expect(offline.querySelector('.cpu-usage-total strong')?.textContent).toBe('—');
    expect(offline.querySelectorAll('[role="meter"]')).toHaveLength(0);
  });
});
