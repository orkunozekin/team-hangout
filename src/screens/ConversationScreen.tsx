import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { editConversationMessage, listConversationMessages, postConversationMessage, reactToConversationMessage, searchConversationMessages } from '../firebase/conversations';
import { CONVERSATION_REACTIONS, type ConversationMessage, type ConversationPage, type ConversationScopeType, type ConversationSearchPage } from '../../shared/conversations';
import { EmptyState, PrimaryButton, Screen, SecondaryButton, Subtitle, Title } from '../components/ui';
import { colors, radius, spacing, type } from '../theme/theme';

export default function ConversationScreen({ orgId, scopeType, scopeId }: { orgId: string; scopeType: ConversationScopeType; scopeId: string }) {
  const [page, setPage] = useState<ConversationPage | null>(null);
  const [items, setItems] = useState<ConversationMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<ConversationMessage | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<ConversationSearchPage | null>(null);
  const [searching, setSearching] = useState(false);
  async function refresh(initial = false) {
    if (initial) { setLoading(true); setPage(null); setItems([]); setDenied(false); }
    setError(null);
    try {
      const next = await listConversationMessages({ orgId, scopeType, scopeId });
      setPage(next);
      setItems(next.items);
      setDenied(false);
    } catch {
      setPage(null);
      setItems([]);
      setDenied(true);
      setError('This conversation is unavailable.');
    } finally { setLoading(false); }
  }
  async function older() {
    if (!page?.nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    setError(null);
    try {
      const next = await listConversationMessages({ orgId, scopeType, scopeId, cursor: page.nextCursor });
      setItems(current => [...current, ...next.items.filter(item => !current.some(row => row.id === item.id))]);
      setPage(next);
    } catch {
      setError('Older messages could not be loaded. Try again.');
    } finally { setLoadingOlder(false); }
  }
  useEffect(() => { void refresh(true); }, [orgId, scopeType, scopeId]);
  async function send() {
    if (!draft.trim()) return;
    setSaving(true); setError(null);
    try {
      if (editing) await editConversationMessage({ orgId, scopeType, scopeId, messageId: editing.id, text: draft.trim(), expectedRevision: editing.revision ?? 0 });
      else await postConversationMessage({ orgId, scopeType, scopeId, text: draft.trim() });
      setDraft('');
      setEditing(null);
      await refresh();
    } catch {
      setError(editing ? 'This edit was not saved. Reload the conversation and try again.' : 'This message was not sent. Youth channels stay closed until the organization approves posting, and removed members cannot post.');
    } finally { setSaving(false); }
  }
  async function react(item: ConversationMessage, emoji: string) {
    setError(null);
    try {
      await reactToConversationMessage({ orgId, scopeType, scopeId, messageId: item.id, emoji, expectedRevision: item.revision ?? 0 });
      await refresh();
    } catch {
      setError('That reaction was not saved.');
    }
  }
  async function find(cursor?: string) {
    if (!query.trim()) return;
    setSearching(true); setError(null);
    try {
      const next = await searchConversationMessages({ orgId, scopeType, scopeId, text: query.trim(), ...(cursor ? { cursor } : {}) });
      setSearch(current => cursor && current ? { ...next, items: [...current.items, ...next.items.filter(item => !current.items.some(row => row.id === item.id))] } : next);
    } catch {
      setError('Search could not be completed.');
    } finally { setSearching(false); }
  }
  const youthClosed = page?.mode === 'youth' && page.youthPosting === 'closed';
  const title = scopeType === 'event' ? 'Event conversation' : scopeType === 'team' ? 'Team conversation' : scopeType === 'division' ? 'Division announcements' : 'Organization announcements';
  return <Screen><ScrollView contentContainerStyle={styles.list}>
    <Title>{title}</Title>
    <Subtitle>{page?.mode === 'youth' ? 'Group channel for guardians, players, and staff' : 'Announcement'}</Subtitle>
    {youthClosed ? <Text accessibilityRole="text" style={styles.banner}>Youth posting is closed until an administrator approves the organization policy.</Text> : null}
    {loading ? <ActivityIndicator color={colors.primary} /> : denied ? <EmptyState message="This conversation is unavailable." /> : <View style={styles.items}>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {!items.length ? <EmptyState message="No messages yet." /> : items.map(item => <View key={item.id} style={styles.card}>
        <Text style={styles.body}>{item.tombstoned ? 'Message removed by a moderator' : item.body}</Text>
        {item.editedAt ? <Text style={styles.pin}>Edited</Text> : null}
        {item.pinned ? <Text style={styles.pin}>Pinned</Text> : null}
        {item.tombstoned ? null : <View style={styles.reactions}>{CONVERSATION_REACTIONS.map(choice => {
          const reaction = item.reactions?.find(row => row.emoji === choice.emoji);
          return <Pressable key={choice.code} accessibilityRole="button" accessibilityLabel={`React with ${choice.emoji}`} accessibilityState={{ selected: reaction?.mine === true }} onPress={() => void react(item, choice.emoji)}><Text style={styles.pin}>{choice.emoji} {reaction?.count ?? 0}</Text></Pressable>;
        })}</View>}
        {item.mine && !item.tombstoned ? <SecondaryButton label="Edit message" onPress={() => { setEditing(item); setDraft(item.body ?? ''); }} /> : null}
      </View>)}
      {page?.nextCursor ? <SecondaryButton label={loadingOlder ? 'Loading older messages' : 'Load older messages'} disabled={loadingOlder} onPress={() => void older()} /> : null}
      <TextInput accessibilityLabel={editing ? 'Replacement text' : 'Message'} value={draft} onChangeText={setDraft} style={styles.input} />
      <PrimaryButton label={editing ? 'Save edit' : 'Send message'} loading={saving} onPress={() => void send()} />
      {editing ? <SecondaryButton label="Cancel edit" onPress={() => { setEditing(null); setDraft(''); }} /> : null}
      <Text style={styles.pin}>Search this channel. Staff notes are not included.</Text>
      <TextInput accessibilityLabel="Search words" value={query} onChangeText={setQuery} style={styles.input} />
      <SecondaryButton label={searching ? 'Searching messages' : 'Search messages'} disabled={searching} onPress={() => void find()} />
      {search?.partial ? <Text style={styles.banner}>More matches may remain. Continue the search.</Text> : null}
      {search && !search.items.length ? <EmptyState message="No matching messages." /> : null}
      {search?.items.map(item => <View key={item.id} style={styles.card}><Text style={styles.body}>{item.body}</Text></View>)}
      {search?.nextCursor ? <SecondaryButton label="Continue search" onPress={() => void find(search.nextCursor ?? undefined)} /> : null}
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
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.sm, color: colors.text },
});
