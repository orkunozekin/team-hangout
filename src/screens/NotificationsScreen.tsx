import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { acknowledgeCriticalUpdate, listNotifications, markNotificationRead, NotificationRow } from '../firebase/notifications';
import { EmptyState, PrimaryButton, Screen, Subtitle, Title } from '../components/ui';
import { colors, radius, spacing, type } from '../theme/theme';

export default function NotificationsScreen() {
  const [rows, setRows] = useState<NotificationRow[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [saving, setSaving] = useState(false);
  async function refresh() { setError(null); try { const page = await listNotifications(); setRows(page.items); } catch { setRows([]); setError('Notifications could not be loaded. Pull to retry.'); } finally { setLoading(false); } }
  useEffect(() => { void refresh(); }, []);
  async function open(row: NotificationRow) { setSelected(row.id); if (row.readAt) return; try { await markNotificationRead(row.id, row.sourceRevision); setRows(current => current.map(item => item.id === row.id ? { ...item, readAt: new Date().toISOString() } : item)); } catch { setError('This update is no longer available. Reload your inbox.'); } }
  async function acknowledge(row: NotificationRow) { setSaving(true); try { await acknowledgeCriticalUpdate(row.id, row.sourceRevision); setRows(current => current.map(item => item.id === row.id ? { ...item, readAt: item.readAt ?? new Date().toISOString(), acknowledgedAt: new Date().toISOString() } : item)); } catch { setError('This critical update changed. Reload before acknowledging it.'); } finally { setSaving(false); } }
  const unread = rows.filter(row => !row.readAt).length;
  return <Screen><Title>Inbox</Title><Subtitle>{unread} unread</Subtitle>
    {loading ? <ActivityIndicator color={colors.primary} /> : <ScrollView refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />} contentContainerStyle={styles.list}>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {!rows.length && !error ? <EmptyState message="No updates yet." /> : rows.map(row => {
        const active = selected === row.id; const failed = row.deliveryStatus === 'permanentFailure';
        const deliveryLabel = failed ? 'Delivery failed' : row.deliveryStatus === 'unknownOutcome' ? 'Delivery outcome unknown'
          : row.deliveryStatus === 'providerAccepted' ? 'Test delivery accepted' : 'In-app update';
        return <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={`Open ${row.title}`} onPress={() => void open(row)} style={[styles.card, !row.readAt && styles.unreadCard]}>
          <View style={styles.heading}><Text style={styles.title}>{row.title}</Text><Text style={[styles.status, !row.readAt && styles.unread]}>{row.acknowledgedAt ? 'Acknowledged' : !row.readAt ? 'Unread' : 'Read'}</Text></View>
          <Text style={styles.body}>{row.body}</Text><Text style={[styles.delivery, (failed || row.deliveryStatus === 'unknownOutcome') && styles.failed]}>{deliveryLabel}</Text>
          {active && row.critical && !row.acknowledgedAt ? <PrimaryButton label="Acknowledge critical update" loading={saving} onPress={() => void acknowledge(row)} /> : null}
        </Pressable>;
      })}
    </ScrollView>}
  </Screen>;
}
const styles = StyleSheet.create({ list: { paddingBottom: 40, gap: spacing.md }, error: { ...type.body, color: colors.danger }, card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm }, unreadCard: { borderColor: colors.primary, borderLeftWidth: 5 }, heading: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.sm }, title: { ...type.bodyMedium, color: colors.text, flexShrink: 1 }, body: { ...type.body, color: colors.textMuted }, status: { ...type.caption, color: colors.textMuted }, unread: { color: colors.primary }, delivery: { ...type.caption, color: colors.success }, failed: { color: colors.danger } });
