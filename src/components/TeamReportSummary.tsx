import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text as NativeText, type TextProps, View } from 'react-native';

import type { AttendanceCounts, ReportRun } from '../../shared/reports';
import { formatRate, REPORT_EXPORT_NOTE, REPORT_STATE_LABELS, reportStatusNote } from '../../shared/reports';
import { exportReport, getReportRun, listTeamReports, reportRequestId, requestTeamAttendanceReport } from '../firebase/reports';
import { clearReportExports, shareReportCsv } from '../lib/reportExport';
import { colors, radius, spacing, type } from '../theme/theme';
import { SecondaryButton } from './ui';

function Text(props: TextProps) {
  return <NativeText maxFontSizeMultiplier={2} {...props} />;
}

const POLL_MS = 2000;
const POLL_LIMIT = 30;
const domainCode = (error: unknown) => (error as { details?: { domainCode?: string } })?.details?.domainCode;
const errorCode = (error: unknown) => (error as { code?: string })?.code ?? '';
const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function explain(error: unknown) {
  if (domainCode(error) === 'REPORTS_DISABLED') return 'Reports are not enabled for this organization.';
  if (errorCode(error) === 'functions/permission-denied') return 'Team summaries are available to this team’s coaches.';
  if (domainCode(error) === 'REPORT_QUEUE_FULL') return 'Several reports are already calculating. Try again shortly.';
  if (domainCode(error) === 'REPORT_NOT_COMPLETE') return 'Only a complete summary can be exported.';
  return 'The summary could not be loaded. Try again.';
}

export function Summary({ run }: { run: ReportRun }) {
  const s = run.summary as AttendanceCounts;
  const excluded = s.events.cancelled + s.events.postponed;
  return (
    <View>
      <View accessible accessibilityLabel={`Presence rate ${formatRate(s.presenceRate)}, ${s.presenceRate.numerator} present or late of ${s.presenceRate.denominator} with a present, late or absent record.`} style={styles.metric}>
        <Text style={styles.label}>Presence rate</Text>
        <Text style={styles.value}>{formatRate(s.presenceRate)}</Text>
        <Text style={styles.copy}>{`${s.presenceRate.numerator} present or late of ${s.presenceRate.denominator} present, late or absent`}</Text>
      </View>
      <View accessible accessibilityLabel={`Completion coverage ${formatRate(s.completionCoverage)}, ${s.completionCoverage.numerator} recorded of ${s.completionCoverage.denominator} eligible.`} style={styles.metric}>
        <Text style={styles.label}>Completion coverage</Text>
        <Text style={styles.value}>{formatRate(s.completionCoverage)}</Text>
        <Text style={styles.copy}>{`${s.completionCoverage.numerator} recorded of ${s.completionCoverage.denominator} eligible`}</Text>
      </View>
      <Text style={styles.copy}>{`Excused ${s.excused} · Unknown ${s.unknown} · Missing ${s.missing}. Missing and unknown are not counted as absent.`}</Text>
      <Text style={styles.copy}>{`${s.events.closed} completed ${s.events.closed === 1 ? 'event' : 'events'}, ${excluded} cancelled or postponed excluded, ${s.events.awaitingClosure} awaiting completion.`}</Text>
    </View>
  );
}

/** Coach-only summary of the latest team attendance snapshot, with visible denominators and missing data. */
export function TeamReportSummary({ orgId, programId, seasonId, teamId }: { orgId: string; programId: string; seasonId: string; teamId: string }) {
  const [run, setRun] = useState<ReportRun | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const request = useRef(0);
  const polls = useRef(0);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState('');
  const exportSeq = useRef(0);
  const shownRun = useRef<string | null>(null);
  shownRun.current = run?.runId ?? null;
  // Files from an interrupted earlier share are removed when the summary opens and closes.
  useEffect(() => {
    live.current = true;
    clearReportExports();
    return () => { live.current = false; clearReportExports(); };
  }, []);
  const current = (seq: number) => live.current && seq === request.current;

  const show = useCallback(async (runId: string) => {
    const seq = ++request.current;
    try {
      const value = await getReportRun(orgId, runId);
      if (current(seq)) { setRun(value.run); setError(''); }
    } catch (reason) {
      if (current(seq)) setError(explain(reason));
    }
  }, [orgId]);

  const load = useCallback(async () => {
    const seq = ++request.current;
    try {
      const page = await listTeamReports(orgId, teamId);
      if (!current(seq)) return;
      const latest = page.items.find(item => item.kind === 'attendance') ?? null;
      setRun(latest);
      setError('');
    } catch (reason) {
      if (current(seq)) setError(explain(reason));
    } finally {
      if (current(seq)) setLoaded(true);
    }
  }, [orgId, teamId]);

  useEffect(() => { void load(); }, [load]);

  // A calculating run is re-read a bounded number of times; rows never show until it is complete.
  useEffect(() => {
    if (!run || (run.state !== 'queued' && run.state !== 'building') || polls.current >= POLL_LIMIT) return;
    const timer = setTimeout(() => { polls.current += 1; void show(run.runId); }, POLL_MS);
    return () => clearTimeout(timer);
  }, [run, show]);

  const update = async () => {
    setBusy(true);
    setError('');
    setExportNote('');
    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);
    const dates = { fromDate: localDay(from), toDate: localDay(today) };
    // Kept until confirmed so a retry after an uncertain failure reuses the same request; new dates get a new ID.
    const key = `${teamId}:${dates.fromDate}:${dates.toDate}`;
    if (pending.current?.key !== key) pending.current = { key, id: reportRequestId() };
    try {
      const result = await requestTeamAttendanceReport(orgId, { programId, seasonId, teamId }, dates, pending.current.id);
      pending.current = null;
      polls.current = 0;
      if (live.current) await show(result.runId);
    } catch (reason) {
      if (live.current) setError(explain(reason));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const exportCsv = async (runId: string) => {
    const seq = ++exportSeq.current;
    const still = () => live.current && seq === exportSeq.current && shownRun.current === runId;
    setExporting(true);
    setExportNote('');
    setError('');
    try {
      const file = await exportReport(orgId, runId);
      // A response for a run that is no longer shown is dropped rather than shared.
      if (!still()) return;
      let outcome;
      try {
        outcome = await shareReportCsv(file, 'Share attendance summary');
      } catch {
        if (still()) setError('The CSV could not be shared. Try again.');
        return;
      }
      if (!still()) return;
      setExportNote(outcome === 'unavailable'
        ? 'Sharing is not available on this device.'
        : `Share sheet closed. ${file.rowCount} team ${file.rowCount === 1 ? 'row' : 'rows'}${file.stale ? ' from a stale snapshot' : ''}; the temporary file was deleted.`);
    } catch (reason) {
      if (still()) setError(explain(reason));
    } finally {
      if (live.current && seq === exportSeq.current) setExporting(false);
    }
  };

  const note = run ? reportStatusNote(run) : null;
  return (
    <View style={styles.section} accessibilityLabel="Team attendance summary">
      <Text accessibilityRole="header" style={styles.heading}>Attendance summary</Text>
      {!loaded ? <ActivityIndicator accessibilityLabel="Loading attendance summary" /> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {loaded && !run && !error ? <Text style={styles.copy}>No attendance summary yet. Create one for the last 30 days.</Text> : null}
      {run ? (
        <>
          <Text style={styles.copy}>{`${run.filters.fromDate} to ${run.filters.toDate} (${run.interval.timeZone}) · ${REPORT_STATE_LABELS[run.state]}${run.stale ? ', stale' : ''}`}</Text>
          {note ? <Text accessibilityRole="alert" style={run.state === 'failed' ? styles.error : styles.pending}>{note}</Text> : null}
          {run.state === 'complete' && run.summary ? (
            <>
              <Summary run={run} />
              <Text style={styles.copy}>{REPORT_EXPORT_NOTE}</Text>
              {exportNote ? <Text accessibilityRole="alert" style={styles.copy}>{exportNote}</Text> : null}
              <SecondaryButton label={exporting ? 'Preparing CSV...' : 'Share CSV'} onPress={() => void exportCsv(run.runId)} disabled={exporting} />
            </>
          ) : null}
        </>
      ) : null}
      {loaded ? <SecondaryButton label={busy ? 'Requesting...' : 'Update last 30 days'} onPress={() => void update()} disabled={busy} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.md },
  heading: { ...type.h2, color: colors.text, marginTop: spacing.md, marginBottom: spacing.xs },
  copy: { ...type.body, color: colors.textMuted, marginBottom: spacing.xs },
  label: { ...type.label, color: colors.text },
  value: { ...type.h2, color: colors.text },
  metric: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.sm, marginVertical: spacing.xs },
  pending: { ...type.label, color: colors.text, backgroundColor: colors.warningBg, borderRadius: radius.sm, padding: spacing.sm, marginVertical: spacing.sm, overflow: 'hidden' },
  error: { ...type.bodyMedium, color: colors.danger, marginVertical: spacing.sm },
});
