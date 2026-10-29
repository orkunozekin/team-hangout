import { csvCell, REPORT_EXPORT_COLUMNS, REPORT_EXPORT_VERSION, reportCsv } from '../../../functions/src/reports/csv';

const ratio = (numerator: number, denominator: number) => ({ numerator, denominator, rate: denominator ? Math.round((numerator / denominator) * 10000) / 10000 : null });
const counts = { events: { closed: 1, cancelled: 2, postponed: 0, awaitingClosure: 1, upcoming: 0 }, eligible: 9, present: 2, late: 1, absent: 2, excused: 1, unknown: 1, missing: 2,
  presenceRate: ratio(3, 5), completionCoverage: ratio(6, 9) };
const run = (patch: Record<string, unknown> = {}) => ({
  runId: 'run-1', kind: 'attendance', reportVersion: 1, reducerVersion: 3, stale: false, staleReason: null, supersededBy: null,
  filters: { kind: 'attendance', programId: 'p1', seasonId: 's1', teamId: null, fromDate: '2026-03-01', toDate: '2026-03-31' },
  interval: { startsAt: '2026-03-01T05:00:00.000Z', endsAt: '2026-04-01T04:00:00.000Z', timeZone: 'America/New_York' },
  sourceCutoff: '2026-04-02T00:00:00.000Z', completedAt: '2026-04-02T00:00:03.000Z', sourceDigest: 'd'.repeat(64),
  formulas: ['presenceRate = (present + late) / (present + late + absent)'], summary: counts, ...patch,
});
// Minimal RFC 4180 reader for assertions: quoted cells, doubled quotes, CRLF records.
function parse(csv: string) {
  const records: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && csv[i + 1] === '\n') { row.push(cell); records.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  return records;
}

test('cells are quoted, quotes doubled and newlines and commas kept inside one field', () => {
  expect(csvCell('Team "A", East\nside')).toBe('"Team ""A"", East\nside"');
  expect(csvCell(0.6667)).toBe('"0.6667"');
  expect(csvCell(null)).toBe('""');
  expect(csvCell(Number.NaN)).toBe('""');
});

test.each([
  ['=HYPERLINK("x")'], ['+1'], ['-1+2'], ['@SUM(A1)'], ['  =1+1'], ['\t=1'], ['\tplain'], ['\rplain'], ['\n=1'], [' =1'], ['＝1+1'],
])('formula-leading text %j is neutralized', value => {
  const cell = csvCell(value);
  expect(cell.startsWith(`"'`)).toBe(true);
});

test('plain text and numbers are not altered', () => {
  expect(csvCell('Team A')).toBe('"Team A"');
  expect(csvCell('a=b')).toBe('"a=b"');
  expect(csvCell(-0)).toBe('"0"');
});

test('a file carries the run, versions, filters, interval and stale flag, then snapshot figures as stored', () => {
  const rows = [
    { kind: 'team', teamId: 't1', label: '=cmd|"/C calc"!A0', ...counts, displayName: 'Synthetic child', notes: 'private', contact: 'x@example.test' },
  ];
  const file = reportCsv(run({ stale: true, staleReason: 'attendanceCorrected' }), rows);
  expect(file.csv.startsWith('﻿')).toBe(true);
  expect(file.fileName).toBe('team-hangout-attendance-2026-03-01-to-2026-03-31-run-1.csv');
  expect(file.rowCount).toBe(1);
  const records = parse(file.csv.slice(1));
  const meta = new Map(records.slice(0, records.findIndex(r => r.length === 1 && r[0] === '')).map(([k, v]) => [k, v]));
  expect(Object.fromEntries(['exportVersion', 'runId', 'reportKind', 'reportVersion', 'formulaVersion', 'filter.programId', 'filter.teamId', 'filter.fromDate',
    'intervalStartsAt', 'timeZone', 'stale', 'staleReason', 'rowCount'].map(k => [k, meta.get(k)]))).toEqual({
    exportVersion: String(REPORT_EXPORT_VERSION), runId: 'run-1', reportKind: 'attendance', reportVersion: '1', formulaVersion: '3', 'filter.programId': 'p1',
    'filter.teamId': '', 'filter.fromDate': '2026-03-01', intervalStartsAt: '2026-03-01T05:00:00.000Z', timeZone: 'America/New_York', stale: 'true',
    staleReason: 'attendanceCorrected', rowCount: '1',
  });
  const blank = records.findIndex(r => r.length === 1 && r[0] === '');
  const [header, summary, team] = records.slice(blank + 1);
  expect(header).toEqual(REPORT_EXPORT_COLUMNS.attendance.map(([name]) => name));
  expect(summary.slice(0, 10)).toEqual(['summary', '', 'All teams', '9', '2', '1', '2', '1', '1', '2']);
  expect(team[2]).toBe(`'=cmd|"/C calc"!A0`);
  expect(team[header.indexOf('presenceRate')]).toBe('0.6');
  expect(team[header.indexOf('completionCoverage')]).toBe('0.6667');
  expect(file.csv).not.toMatch(/Synthetic child|private|example\.test/);
});

test('zero rows still export the summary, and a zero denominator reads not enough data', () => {
  const empty = { ...counts, eligible: 0, presenceRate: ratio(0, 0), completionCoverage: ratio(0, 0) };
  const file = reportCsv(run({ summary: empty }), []);
  const records = parse(file.csv.slice(1));
  const header = records.find(r => r[0] === 'rowKind')!;
  const data = records.slice(records.indexOf(header) + 1);
  expect(data).toHaveLength(1);
  expect(data[0][header.indexOf('presenceRate')]).toBe('not enough data');
  expect(file.rowCount).toBe(0);
});

test('facility exports use their own versioned columns and filters', () => {
  const file = reportCsv(run({ kind: 'facility', filters: { kind: 'facility', facilityId: 'f1', fromDate: '2026-03-08', toDate: '2026-03-08' },
    summary: { availableMinutes: 420, bookedMinutes: 150, utilization: ratio(150, 420), resources: 2 } }), [
    { kind: 'resource', resourceId: 'r1', label: 'Field 1', availableMinutes: 420, bookedMinutes: 150, utilization: ratio(150, 420) },
  ]);
  const records = parse(file.csv.slice(1));
  expect(records.some(r => r[0] === 'filter.facilityId' && r[1] === 'f1')).toBe(true);
  expect(records.some(r => r[0] === 'filter.programId')).toBe(false);
  const header = records.find(r => r[0] === 'rowKind')!;
  expect(header.slice(0, 3)).toEqual(['rowKind', 'resourceId', 'resource']);
  expect(records.at(-1)!.slice(0, 3)).toEqual(['resource', 'r1', 'Field 1']);
  expect(() => reportCsv(run({ kind: 'roster' }), [])).toThrow('Unsupported');
});
