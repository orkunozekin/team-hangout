import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { acknowledgeCriticalUpdate, listNotifications, markNotificationRead, NotificationRow } from '../firebase/notifications';
import { EmptyState, PrimaryButton, Screen, Subtitle, Title } from '../components/ui';
import { colors, radius, spacing, type } from '../theme/theme';
import { registerPushNotifications, syncExistingPushPermission } from '../lib/pushRegistration';

export default function NotificationsScreen({ userId, pushProjectId, notice }: { userId?: string; pushProjectId?: string; notice?: string | null }) {
  const [rows, setRows] = useState<NotificationRow[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [saving, setSaving] = useState(false), [refreshing, setRefreshing] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null), [loadingMore, setLoadingMore] = useState(false);
  const [pushState, setPushState] = useState<'idle' | 'granted' | 'denied' | 'undetermined' | 'unavailable'>('idle');
  async function refresh() { setRefreshing(true); setError(null); try { const page = await listNotifications(); setRows(page.items); setNextCursor(page.nextCursor); } catch { setRows([]); setNextCursor(null); setError('Notifications could not be loaded. Pull to retry.'); } finally { setLoading(false); setRefreshing(false); } }
  async function loadMore() { if (!nextCursor || loadingMore) return; setLoadingMore(true); setError(null); try { const page = await listNotifications(nextCursor); setRows(current => [...current, ...page.items.filter(row => !current.some(existing => existing.id === row.id))]); setNextCursor(page.nextCursor); } catch { setError('More notifications could not be loaded. Try again.'); } finally { setLoadingMore(false); } }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (!userId || !pushProjectId) { setPushState('unavailable'); return; }
    let active = true; void syncExistingPushPermission(userId, pushProjectId).then(result => { if (active) setPushState(result.permissionState); })
      .catch(() => { if (active) setPushState('unavailable'); }); return () => { active = false; }; }, [userId, pushProjectId]);
  async function enablePush() { if (!userId || !pushProjectId) return; setSaving(true); setError(null); try {
    const result = await registerPushNotifications(userId, pushProjectId); setPushState(result.permissionState);
    if (result.permissionState === 'denied') setError('Push permission is denied. In-app updates and email fallback remain available.');
  } catch { setPushState('unavailable'); setError('Push setup is unavailable. In-app updates remain available.'); } finally { setSaving(false); } }
  async function open(row: NotificationRow) { setSelected(row.id); if (row.readAt) return; try { await markNotificationRead(row.id, row.sourceRevision); setRows(current => current.map(item => item.id === row.id ? { ...item, readAt: new Date().toISOString() } : item)); } catch { setError('This update is no longer available. Reload your inbox.'); } }
  async function acknowledge(row: NotificationRow) { setSaving(true); try { await acknowledgeCriticalUpdate(row.id, row.sourceRevision); setRows(current => current.map(item => item.id === row.id ? { ...item, readAt: item.readAt ?? new Date().toISOString(), acknowledgedAt: new Date().toISOString() } : item)); } catch { setError('This critical update changed. Reload before acknowledging it.'); } finally { setSaving(false); } }
  const unread = rows.filter(row => !row.readAt).length;
  const pushLabel = pushState === 'granted' ? 'Push updates enabled' : pushState === 'denied' ? 'Push permission denied'
    : pushState === 'unavailable' ? 'Push setup unavailable' : 'Push updates are off';
  return <Screen><ScrollView refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />} contentContainerStyle={styles.list}>
    <Title>Inbox</Title><Subtitle>{unread} unread</Subtitle>
    {notice ? <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text> : null}
    <View style={styles.pushCard}><Text style={styles.pushTitle}>{pushLabel}</Text><Text style={styles.body}>In-app updates stay authoritative. Email may be used as a fallback when enabled by your organization.</Text>
      {pushState !== 'granted' ? <PrimaryButton label="Enable push updates" loading={saving} disabled={!pushProjectId} onPress={() => void enablePush()} /> : null}</View>
    {loading ? <ActivityIndicator color={colors.primary} /> : <View style={styles.items}>
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
      })}{nextCursor ? <PrimaryButton label="Load more updates" loading={loadingMore} onPress={() => void loadMore()} /> : null}
    </View>}
  </ScrollView></Screen>;
}
const styles = StyleSheet.create({ list: { paddingBottom: 40 }, items: { gap: spacing.md }, error: { ...type.body, color: colors.danger }, notice: { ...type.body, color: colors.text, backgroundColor: colors.card, borderRadius: radius.sm, padding: spacing.sm, marginBottom: spacing.md }, pushCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm, marginBottom: spacing.md }, pushTitle: { ...type.bodyMedium, color: colors.text }, card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm }, unreadCard: { borderColor: colors.primary, borderLeftWidth: 5 }, heading: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.sm }, title: { ...type.bodyMedium, color: colors.text, flexShrink: 1 }, body: { ...type.body, color: colors.textMuted }, status: { ...type.caption, color: colors.textMuted }, unread: { color: colors.primary }, delivery: { ...type.caption, color: colors.success }, failed: { color: colors.danger } });
