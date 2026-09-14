'use client';

import type { CSSProperties } from 'react';
import type { ResourceUsage } from '@serverforge/core';
import { Icon } from './Icon';

const coresLabel = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });

export function CpuUsage({
  usage,
  configuredCores,
}: {
  usage?: ResourceUsage;
  configuredCores: number;
}) {
  const limit = usage?.cpuLimitCores ?? configuredCores;
  const used = usage ? Math.max(0, usage.cpuPercent / 100) : 0;
  const perCore = usage?.cpuPerCorePercent;
  const capacity = limit || usage?.cpuHostCores || Math.max(1, Math.ceil(used));
  const blocks = Math.ceil(Math.max(capacity, used));

  return (
    <section className="cpu-usage-card" aria-label="CPU core usage">
      <div className="cpu-usage-heading">
        <div>
          <div className="resource-card-label">
            <Icon name="cpu" size={16} />
            CPU usage
          </div>
          <div className="cpu-usage-total">
            <strong>{usage ? coresLabel(used) : '—'}</strong>
            <span>{limit ? `of ${coresLabel(limit)} cores` : 'cores in use'}</span>
          </div>
        </div>
        <div className="cpu-usage-summary">
          {usage && limit > 0 ? (
            <strong>{coresLabel((used / limit) * 100)}% of allocation</strong>
          ) : (
            <strong>{limit ? `${coresLabel(limit)} core allocation` : 'No CPU limit'}</strong>
          )}
          <span>
            {usage ? `${usage.cpuPercent.toFixed(1)}% combined CPU` : 'Waiting for live readings'}
          </span>
        </div>
      </div>
      {perCore?.length ? (
        <>
          <div className="cpu-cores-grid">
            {perCore.map((percent, index) => (
              <div className="cpu-core" key={index}>
                <div>
                  <span>Core {index + 1}</span>
                  <strong>{percent.toFixed(0)}%</strong>
                </div>
                <div
                  className="cpu-core-track"
                  role="meter"
                  aria-label={`Server CPU usage on logical core ${index + 1}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, Math.max(0, percent))}
                  aria-valuetext={`${percent.toFixed(1)}%`}
                >
                  <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="cpu-usage-note">
            Server usage on each host logical core. The CPU allocation is shared across these cores.
          </p>
        </>
      ) : (
        <>
          <div className="cpu-capacity-heading">
            <strong>Core capacity</strong>
            <span>Each block = 1 core</span>
          </div>
          <div
            className="cpu-capacity-blocks"
            role="img"
            aria-label={
              usage
                ? `${coresLabel(used)} cores in use${limit ? ` out of ${coresLabel(limit)} allocated` : ', no CPU limit'}. Blocks represent total capacity, not individual physical cores.`
                : 'CPU capacity readings unavailable'
            }
          >
            {Array.from({ length: blocks }, (_, index) => {
              const fill = usage ? Math.min(1, Math.max(0, used - index)) : 0;
              const allocated = Math.min(1, Math.max(0, capacity - index));
              return (
                <div
                  key={index}
                  className="cpu-capacity-block"
                  aria-hidden="true"
                  style={
                    {
                      '--core-fill': `${fill * 100}%`,
                      '--core-capacity': `${allocated * 100}%`,
                    } as CSSProperties
                  }
                >
                  <div className="cpu-capacity-track">
                    <span />
                  </div>
                  <span>{usage ? `${coresLabel(fill)} used` : '—'}</span>
                </div>
              );
            })}
          </div>
          <p className="cpu-usage-note">
            {usage
              ? 'Total usage shown in core-sized blocks. Individual core readings aren’t available on this host.'
              : 'Core usage will appear when live readings are available.'}
          </p>
        </>
      )}
      {usage?.cpuLimitCores !== undefined && usage.cpuLimitCores !== configuredCores && (
        <p className="cpu-usage-note">
          Showing the active limit. Your saved allocation applies on the next restart.
        </p>
      )}
    </section>
  );
}
