import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { eventCardContent, type EventCardInput } from '../lib/eventCard';
import { colors, fonts, radius, shadow, spacing, type } from '../theme/theme';

type Props = {
  event: EventCardInput;
  displayZone?: string;
  onPress?: () => void;
  children?: React.ReactNode;
};

/** Shared schedule card for the team Schedule tab and the household calendar. */
export default function EventCard({ event, displayZone, onPress, children }: Props) {
  const content = eventCardContent(event, displayZone);
  const match = content.typeLabel === 'Match';
  const body = (
    <>
      <View style={styles.top}>
        <View style={[styles.badge, match ? styles.badgeMatch : styles.badgePractice]}>
          <Text style={[styles.badgeText, match ? styles.badgeTextMatch : styles.badgeTextPractice]}>{content.typeLabel}</Text>
        </View>
        {content.statusLabel ? <Text style={styles.status}>{content.statusLabel}</Text> : null}
      </View>
      <Text style={styles.title}>{content.title}</Text>
      <Text style={styles.when}>{content.when}</Text>
      {content.eventLocalWhen ? <Text style={styles.meta}>{content.eventLocalWhen}</Text> : null}
      {content.teams ? <Text style={styles.meta}>{content.teams}</Text> : null}
      {content.participants ? <Text style={styles.meta}>{content.participants}</Text> : null}
      {content.location ? <Text style={styles.meta}>{content.location}</Text> : null}
      {content.context ? <Text style={styles.meta}>{content.context}</Text> : null}
      {children}
    </>
  );
  return onPress ? (
    <Pressable style={styles.card} accessibilityRole="button" onPress={onPress}>{body}</Pressable>
  ) : (
    <View style={styles.card}>{body}</View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md, ...shadow.card },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm, gap: spacing.sm },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.full },
  badgePractice: { backgroundColor: colors.practiceBg },
  badgeMatch: { backgroundColor: colors.matchBg },
  badgeText: { ...type.tiny, textTransform: 'uppercase' },
  badgeTextPractice: { color: colors.practice },
  badgeTextMatch: { color: colors.match },
  status: { ...type.label, color: colors.danger, flexShrink: 1 },
  title: { fontFamily: fonts.semiBold, fontSize: 16, color: colors.text, marginBottom: 4 },
  when: { ...type.label, color: colors.text, marginBottom: 4 },
  meta: { ...type.caption, color: colors.textMuted, marginBottom: 2 },
});
