import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  listConversationBlocks,
  listConversationReports,
  moderateConversationMessage,
  resolveConversationReport,
  unblockConversationMember,
} from '../firebase/conversations';
import { CONVERSATION_REPORT_REASONS, type ConversationBlock, type ConversationReport, type ConversationScopeType } from '../../shared/conversations';
import { DestructiveButton, EmptyState, Screen, SecondaryButton, Subtitle, Title } from '../components/ui';
import { colors, radius, spacing, type } from '../theme/theme';

const SCOPE_LABELS: Record<ConversationScopeType, string> = {
  organization: 'Organization announcements',
  division: 'Division announcements',
  team: 'Team conversation',
  event: 'Event conversation',
};
const reasonLabel = (code: string) => CONVERSATION_REPORT_REASONS.find(choice => choice.code === code)?.label ?? 'Something else';
const day = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Blocked members for everyone, plus the report queue when the server confirms the caller moderates this organization. */
export default function ConversationSafetyScreen({ orgId, organizationName }: { orgId: string; organizationName?: string }) {
  const [blocks, setBlocks] = useState<ConversationBlock[] | null>(null);
  const [reports, setReports] = useState<ConversationReport[] | null>(null);
  const [reportCursor, setReportCursor] = useState<string | null>(null);
  const [moderator, setModerator] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [blockResult, reportResult] = await Promise.allSettled([listConversationBlocks(orgId), listConversationReports({ orgId })]);
    if (blockResult.status === 'fulfilled') setBlocks(blockResult.value.items);
    else { setBlocks([]); setError('Blocked members could not be loaded.'); }
    if (reportResult.status === 'fulfilled') {
      setModerator(true);
      setReports(reportResult.value.items);
      setReportCursor(reportResult.value.nextCursor);
    } else {
      // A denied queue read means this person does not moderate the organization.
      setModerator(false);
      setReports(null);
    }
  }, [orgId]);
  useEffect(() => { void load(); }, [load]);

  async function act(key: string, action: () => Promise<unknown>, failure: string) {
    setBusy(key); setError(null);
    try { await action(); await load(); }
    catch { setError(failure); }
    finally { setBusy(null); }
  }
  async function more() {
    if (!reportCursor) return;
    try {
      const next = await listConversationReports({ orgId, cursor: reportCursor });
      setReports(current => [...(current ?? []), ...next.items.filter(item => !current?.some(row => row.id === item.id))]);
      setReportCursor(next.nextCursor);
    } catch { setError('More reports could not be loaded.'); }
  }
  const remove = (report: ConversationReport) => act(report.id, async () => {
    if (!report.messageRemoved) {
      await moderateConversationMessage({ orgId, scopeType: report.scopeType, scopeId: report.scopeId, messageId: report.messageId, reason: `Report: ${reasonLabel(report.reason)}` });
    }
    await resolveConversationReport({ orgId, reportId: report.id, resolution: 'removed' });
  }, 'The message was not removed. Try again.');

  return <Screen><ScrollView contentContainerStyle={styles.list}>
    <Title>Safety</Title>
    {organizationName ? <Subtitle>{organizationName}</Subtitle> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {moderator ? <>
      <Text accessibilityRole="header" style={styles.heading}>Reported messages</Text>
      {!reports?.length ? <EmptyState message="No open reports." /> : reports.map(report => <View key={report.id} style={styles.card}>
        <Text style={styles.meta}>{reasonLabel(report.reason)} · {SCOPE_LABELS[report.scopeType]} · {day(report.createdAt)}</Text>
        <Text style={styles.body}>{report.reportedBody ?? 'No text'}</Text>
        {report.note ? <Text style={styles.note}>Reporter note: {report.note}</Text> : null}
        <Text style={styles.meta}>Reported by {report.reporterUid ?? 'Deleted user'} · Author {report.authorUid ?? 'Deleted user'}</Text>
        {report.messageRemoved ? <Text style={styles.meta}>The message is already removed.</Text> : report.editedSinceReport ? <Text style={styles.meta}>Edited since the report.</Text> : null}
        <DestructiveButton
          label="Remove message"
          loading={busy === report.id}
          disabled={busy != null}
          onPress={() => void remove(report)}
          confirm={{ title: 'Remove this message?', message: 'Its text and files are removed for everyone in the channel. This cannot be undone.', confirmLabel: 'Remove message' }}
        />
        <DestructiveButton
          label="Dismiss report"
          disabled={busy != null}
          onPress={() => void act(report.id, () => resolveConversationReport({ orgId, reportId: report.id, resolution: 'dismissed' }), 'The report was not dismissed. Try again.')}
          confirm={{ title: 'Dismiss this report?', message: 'The message stays visible and the report leaves the queue. This cannot be undone.', confirmLabel: 'Dismiss report' }}
        />
      </View>)}
      {reportCursor ? <SecondaryButton label="Load more reports" onPress={() => void more()} /> : null}
    </> : null}
    <Text accessibilityRole="header" style={styles.heading}>Blocked members</Text>
    <Text style={styles.meta}>Blocking hides a member’s messages from you in team and event channels. Staff and coaches cannot be blocked, and announcements always stay visible.</Text>
    {blocks == null ? <ActivityIndicator color={colors.primary} accessibilityLabel="Loading blocked members" /> : !blocks.length ? <EmptyState message="You have not blocked anyone." /> : blocks.map(block => <View key={block.id} style={styles.card}>
      <Text style={styles.body}>Member blocked from a {SCOPE_LABELS[block.scopeType].toLowerCase()}</Text>
      <Text style={styles.meta}>Blocked {day(block.createdAt)}</Text>
      <SecondaryButton
        label="Unblock member"
        loading={busy === block.id}
        disabled={busy != null}
        onPress={() => void act(block.id, () => unblockConversationMember({ orgId, blockId: block.id }), 'This member was not unblocked. Try again.')}
      />
    </View>)}
  </ScrollView></Screen>;
}

const styles = StyleSheet.create({
  list: { paddingBottom: 40, gap: spacing.md },
  heading: { ...type.body, color: colors.textMuted, marginTop: spacing.md },
  error: { ...type.body, color: colors.danger },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
  body: { ...type.body, color: colors.text },
  note: { ...type.body, color: colors.text, fontStyle: 'italic' },
  meta: { ...type.caption, color: colors.textMuted },
});
