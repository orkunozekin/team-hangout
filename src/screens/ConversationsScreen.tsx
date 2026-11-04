import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { listHouseholdAgenda } from '../firebase/agenda';
import {
  householdConversationTargets,
  teamConversationTargets,
  type ConversationRoute,
  type ConversationTarget,
} from '../lib/conversationNavigation';
import { Screen, SecondaryButton, Title } from '../components/ui';
import { colors, fonts, spacing, type } from '../theme/theme';
import type { ConversationScopeType } from '../../shared/conversations';

const CONVERSATION_WINDOW_DAYS = 30;
// Bounds the read cost of a very busy household; later pages are rare inside a 30 day window.
const MAX_AGENDA_PAGES = 10;
const SECTIONS: { title: string; scopes: ConversationScopeType[] }[] = [
  { title: 'Announcements', scopes: ['organization', 'division'] },
  { title: 'Teams', scopes: ['team'] },
  { title: 'Upcoming events', scopes: ['event'] },
];

export function mergeConversationTargets(...groups: ConversationTarget[][]): ConversationTarget[] {
  const seen = new Set<string>();
  return groups.flat().filter(target => {
    const key = `${target.scopeType}:${target.orgId}:${target.scopeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadAgendaConversations(from: Date, to: Date): Promise<ConversationTarget[]> {
  const found: ConversationTarget[][] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_AGENDA_PAGES; page++) {
    const result = await listHouseholdAgenda({ from: from.toISOString(), to: to.toISOString(), pageSize: 50, ...(cursor ? { cursor } : {}) });
    found.push(householdConversationTargets(result.teams, result.items));
    cursor = result.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return mergeConversationTargets(...found);
}

export default function ConversationsScreen({
  activeTeam,
  onOpen,
}: {
  activeTeam?: { id: string; name: string; schemaVersion?: number; orgId?: string } | null;
  onOpen: (target: ConversationRoute) => void;
}) {
  const [targets, setTargets] = useState<ConversationTarget[] | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setTargets(null);
    setError('');
    const from = new Date();
    const to = new Date(from.getTime() + CONVERSATION_WINDOW_DAYS * 86_400_000);
    const teamTargets = activeTeam ? teamConversationTargets(activeTeam) : [];
    loadAgendaConversations(from, to)
      .then(found => {
        if (active) setTargets(mergeConversationTargets(found, teamTargets));
      })
      .catch(() => {
        if (!active) return;
        setTargets(teamTargets);
        setError('Unable to load all conversations. Check your connection and try again.');
      });
    return () => { active = false; };
  }, [activeTeam, version]);

  const reload = useCallback(() => setVersion(v => v + 1), []);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.list}>
        <Title>Conversations</Title>
        {error ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
        {!targets ? <ActivityIndicator accessibilityLabel="Loading conversations" /> : null}
        {targets && !targets.length && !error ? (
          <Text style={styles.copy}>No conversations yet. Team, event and organization conversations appear here once your organization publishes them.</Text>
        ) : null}
        {targets ? SECTIONS.map(section => {
          const rows = targets.filter(target => section.scopes.includes(target.scopeType));
          if (!rows.length) return null;
          return (
            <React.Fragment key={section.title}>
              <Text accessibilityRole="header" style={styles.heading}>{section.title}</Text>
              {rows.map(target => (
                <Pressable
                  key={`${target.scopeType}:${target.orgId}:${target.scopeId}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${target.label}`}
                  onPress={() => onOpen({ orgId: target.orgId, scopeType: target.scopeType, scopeId: target.scopeId })}
                  style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
                >
                  <Ionicons
                    name={(target.scopeType === 'event' ? 'calendar-outline' : target.scopeType === 'team' ? 'people-outline' : 'megaphone-outline') as never}
                    size={20}
                    color={colors.primary}
                  />
                  <Text style={styles.label}>{target.label}</Text>
                  <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
                </Pressable>
              ))}
            </React.Fragment>
          );
        }) : null}
        <SecondaryButton label="Refresh conversations" onPress={reload} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: spacing.xl, gap: spacing.sm },
  heading: { fontFamily: fonts.semiBold, fontSize: 15, color: colors.textMuted, marginTop: spacing.md },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  label: { flex: 1, fontFamily: fonts.medium, fontSize: 16, color: colors.text },
  copy: { ...type.body, color: colors.textMuted },
  error: { ...type.body, color: colors.danger },
});
