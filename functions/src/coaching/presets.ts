/** Server copy of slot identity only. Keep aligned with src/lib/coaching/lineupSurface.ts (a Jest test enforces it). */
export const LINEUP_PRESETS: Record<string, { version: number; units: { id: string; slots: string[] }[] }> = {
  soccer: {
    version: 1,
    units: [{ id: 'starting', slots: ['gk', 'lb', 'lcb', 'rcb', 'rb', 'lm', 'cm', 'rm', 'lw', 'st', 'rw'] }],
  },
  basketball: {
    version: 1,
    units: [{ id: 'onCourt', slots: ['pg', 'sg', 'sf', 'pf', 'c'] }],
  },
  football: {
    version: 1,
    units: [
      { id: 'offense', slots: ['qb', 'rb', 'wr-l', 'wr-r', 'te', 'lt', 'lg', 'c', 'rg', 'rt', 'slot'] },
      { id: 'defense', slots: ['de-l', 'dt-l', 'dt-r', 'de-r', 'olb-l', 'mlb', 'olb-r', 'cb-l', 'cb-r', 'fs', 'ss'] },
      { id: 'specialTeams', slots: ['k', 'p', 'ls', 'h', 'st-1', 'st-2', 'st-3', 'st-4', 'st-5', 'st-6', 'rs'] },
    ],
  },
};
