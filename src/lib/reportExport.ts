import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/** Report CSVs live only in this cache folder, and only while the share sheet is open. */
const EXPORT_FOLDER = 'report-exports';
const exportDirectory = () => new Directory(Paths.cache, EXPORT_FOLDER);

/** Removes every temporary report export, including files left by an interrupted share. */
export function clearReportExports() {
  try {
    const directory = exportDirectory();
    if (directory.exists) directory.delete();
  } catch {
    // A locked or already removed cache folder is retried on the next export.
  }
}

const safeFileName = (name: string) => `${name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+(csv)?$/i, '').slice(0, 120) || 'report'}.csv`;

export type ShareOutcome = 'closed' | 'unavailable';

/**
 * Writes the server-built CSV to a scoped cache file, opens the native share sheet and deletes the file
 * when the sheet closes, whether the user shared, cancelled or the share failed.
 */
export async function shareReportCsv(file: { fileName: string; csv: string }, dialogTitle: string): Promise<ShareOutcome> {
  if (!(await Sharing.isAvailableAsync())) return 'unavailable';
  clearReportExports();
  const directory = exportDirectory();
  directory.create({ intermediates: true, idempotent: true });
  const target = new File(directory, safeFileName(file.fileName));
  try {
    target.create({ overwrite: true });
    target.write(file.csv);
    await Sharing.shareAsync(target.uri, { mimeType: 'text/csv', UTI: 'public.comma-separated-values-text', dialogTitle });
    return 'closed';
  } finally {
    clearReportExports();
  }
}
