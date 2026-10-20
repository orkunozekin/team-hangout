import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { listConversationMessages, postConversationMessage } from '../firebase/conversations';
import type { ConversationPage, ConversationScopeType } from '../../shared/conversations';
import { EmptyState, PrimaryButton, Screen, Subtitle, Title } from '../components/ui';
import { colors, radius, spacing, type } from '../theme/theme';

export default function ConversationScreen({ orgId, scopeType, scopeId }: { orgId: string; scopeType: ConversationScopeType; scopeId: string }) {
  const [page, setPage] = useState<ConversationPage | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  async function refresh() {
    setError(null);
    try {
      setPage(await listConversationMessages({ orgId, scopeType, scopeId }));
      setDenied(false);
    } catch {
      setPage(null);
      setDenied(true);
      setError('This conversation is unavailable.');
    } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, [orgId, scopeType, scopeId]);
  async function send() {
    if (!draft.trim()) return;
    setSaving(true); setError(null);
    try {
      await postConversationMessage({ orgId, scopeType, scopeId, text: draft.trim() });
      setDraft('');
      await refresh();
    } catch {
      setError('This message was not sent. Youth channels stay closed until the organization approves posting, and removed members cannot post.');
    } finally { setSaving(false); }
  }
  const youthClosed = page?.mode === 'youth' && page.youthPosting === 'closed';
  return <Screen><ScrollView contentContainerStyle={styles.list}>
    <Title>Team conversation</Title>
    <Subtitle>{page?.mode === 'youth' ? 'Group channel for guardians, players, and staff' : 'Announcement'}</Subtitle>
    {youthClosed ? <Text accessibilityRole="text" style={styles.banner}>Youth posting is closed until an administrator approves the organization policy.</Text> : null}
    {loading ? <ActivityIndicator color={colors.primary} /> : denied ? <EmptyState message="This conversation is unavailable." /> : <View style={styles.items}>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {!page?.items.length ? <EmptyState message="No messages yet." /> : page.items.map(item => <View key={item.id} style={styles.card}>
        <Text style={styles.body}>{item.tombstoned ? 'Message removed by a moderator' : item.body}</Text>
        {item.pinned ? <Text style={styles.pin}>Pinned</Text> : null}
      </View>)}
      <TextInput accessibilityLabel="Message" value={draft} onChangeText={setDraft} style={styles.input} />
      <PrimaryButton label="Send message" loading={saving} onPress={() => void send()} />
    </View>}
  </ScrollView></Screen>;
}
const styles = StyleSheet.create({
  list: { paddingBottom: 40, gap: spacing.md },
  items: { gap: spacing.md },
  banner: { ...type.body, color: colors.text, backgroundColor: '#fff6e8', borderRadius: radius.sm, padding: spacing.sm },
  error: { ...type.body, color: colors.danger },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
  body: { ...type.body, color: colors.text },
  pin: { ...type.caption, color: colors.primary },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.sm, color: colors.text },
});
