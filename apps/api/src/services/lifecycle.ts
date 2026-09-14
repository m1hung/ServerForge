/** One API process owns supervision and mutations for this installation. */
export const lifecycle = {
  mode: 'ready' as 'starting' | 'ready' | 'maintenance' | 'stopping',
  supervisorRequired: false,
  lastSupervisorTickAt: null as number | null,
};
