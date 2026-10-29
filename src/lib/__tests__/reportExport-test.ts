const mockFiles = new Map<string, string>();
const mockShare = jest.fn();
const mockAvailable = jest.fn();
jest.mock('expo-file-system', () => {
  class Directory {
    uri: string;
    constructor(base: { uri: string } | string, name: string) { this.uri = `${typeof base === 'string' ? base : base.uri}/${name}`; }
    get exists() { return [...mockFiles.keys()].some(key => key === this.uri || key.startsWith(`${this.uri}/`)); }
    create() { mockFiles.set(this.uri, '<dir>'); }
    delete() { for (const key of [...mockFiles.keys()]) if (key === this.uri || key.startsWith(`${this.uri}/`)) mockFiles.delete(key); }
  }
  class File {
    uri: string;
    constructor(base: { uri: string }, name: string) { this.uri = `${base.uri}/${name}`; }
    create() { mockFiles.set(this.uri, ''); }
    write(content: string) { mockFiles.set(this.uri, content); }
  }
  return { Directory, File, Paths: { cache: { uri: 'cache:' } } };
});
jest.mock('expo-sharing', () => ({ isAvailableAsync: () => mockAvailable(), shareAsync: (...args: unknown[]) => mockShare(...args) }));
import { clearReportExports, shareReportCsv } from '../reportExport';

const file = { fileName: 'team-hangout-attendance-2026-03-01-to-2026-03-31-run 1.csv', csv: '"a"\r\n' };
beforeEach(() => {
  mockFiles.clear();
  jest.clearAllMocks();
  mockAvailable.mockResolvedValue(true);
});

test('writes one scoped cache file, shares it as CSV and deletes it when the sheet closes', async () => {
  mockFiles.set('cache:/report-exports/leftover.csv', 'old');
  mockShare.mockImplementation(async (uri: string) => {
    expect(mockFiles.get(uri)).toBe('"a"\r\n');
    expect(mockFiles.has('cache:/report-exports/leftover.csv')).toBe(false);
  });
  await expect(shareReportCsv(file, 'Share')).resolves.toBe('closed');
  expect(mockShare).toHaveBeenCalledWith('cache:/report-exports/team-hangout-attendance-2026-03-01-to-2026-03-31-run-1.csv',
    { mimeType: 'text/csv', UTI: 'public.comma-separated-values-text', dialogTitle: 'Share' });
  expect(mockFiles.size).toBe(0);
});

test('a cancelled or failed share still removes the temporary file', async () => {
  mockShare.mockRejectedValue(new Error('cancelled'));
  await expect(shareReportCsv(file, 'Share')).rejects.toThrow('cancelled');
  expect(mockFiles.size).toBe(0);
});

test('no file is written when sharing is unavailable', async () => {
  mockAvailable.mockResolvedValue(false);
  await expect(shareReportCsv(file, 'Share')).resolves.toBe('unavailable');
  expect(mockShare).not.toHaveBeenCalled();
  expect(mockFiles.size).toBe(0);
});

test('clearing tolerates a missing folder', () => {
  expect(() => clearReportExports()).not.toThrow();
});
