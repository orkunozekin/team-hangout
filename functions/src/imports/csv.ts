/** Strict RFC 4180-style CSV. Never truncate files or rows. */
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 5000;
export const columns = [
  "externalId",
  "participantName",
  "kind",
  "teamExternalId",
  "guardianEmail1",
  "guardianEmail2",
];
export function parseCsv(bytes: Uint8Array): string[][] {
  if (bytes.length > MAX_BYTES)
    throw new Error("CSV exceeds 5 MB. Split the file into smaller imports.");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, "");
  } catch {
    throw new Error(
      "CSV must be valid UTF-8. Export it as UTF-8 CSV and retry.",
    );
  }
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  const cell = () => {
    row.push(field);
    field = "";
    closed = false;
  };
  const line = () => {
    cell();
    if (row.some((value) => value !== "")) rows.push(row);
    row = [];
    if (rows.length > MAX_ROWS + 1)
      throw new Error(
        "CSV exceeds 5,000 rows. Split the file into smaller imports.",
      );
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === ",") cell();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      line();
    } else if (c === '"' && !field && !closed) quoted = true;
    else {
      if (closed || c === '"') throw new Error("Malformed quoted CSV field.");
      field += c;
    }
  }
  if (quoted) throw new Error("Unclosed quoted CSV field.");
  if (field || row.length || closed) line();
  if (rows.length < 2)
    throw new Error("CSV needs headers and at least one data row.");
  if (
    rows[0].some((v) => !v.trim()) ||
    new Set(rows[0]).size !== rows[0].length
  )
    throw new Error("Headers must be unique and non-empty.");
  if (rows.some((row) => row.length !== rows[0].length))
    throw new Error(
      "Every CSV row must have the same number of fields as the headers.",
    );
  return rows;
}
export function safeCsv(rows: unknown[][]): string {
  return rows
    .map((row) =>
      row
        .map((value) => {
          let v = String(value ?? "");
          if (/^[\s]*[=+@-]/.test(v)) v = `'${v}`;
          return `"${v.replace(/"/g, '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
}
