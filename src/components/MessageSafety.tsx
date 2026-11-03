import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { CONVERSATION_REPORT_REASONS, type ConversationReportReason } from '../../shared/conversations';
import { CHIP_MAX_FONT_SCALE, ConfirmDialog, LinkButton, PrimaryButton, SecondaryButton } from './ui';
import { colors, radius, spacing, type } from '../theme/theme';

/** Report and block actions under someone else's message. Reports go to organization moderators only. */
export function MessageSafety({
  canBlock,
  onReport,
  onBlock,
}: {
  canBlock: boolean;
  onReport: (reason: ConversationReportReason, note: string) => Promise<void>;
  onBlock: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ConversationReportReason | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmingBlock, setConfirmingBlock] = useState(false);
  async function submit() {
    if (!reason) return;
    setSaving(true); setStatus(null);
    try {
      await onReport(reason, note.trim());
      setOpen(false); setReason(null); setNote('');
      setStatus('Reported. Organization moderators will review it.');
    } catch {
      setStatus('This report was not sent. Try again.');
    } finally { setSaving(false); }
  }
  async function block() {
    setStatus(null);
    try { await onBlock(); }
    catch (caught) { setStatus(caught instanceof Error && caught.message ? caught.message : 'This member was not blocked.'); }
  }
  return <View style={styles.wrap}>
    {open ? <View style={styles.panel}>
      <Text accessibilityRole="header" style={styles.heading}>Why are you reporting this message?</Text>
      <View style={styles.reasons}>{CONVERSATION_REPORT_REASONS.map(choice => <Pressable
        key={choice.code}
        accessibilityRole="radio"
        accessibilityLabel={choice.label}
        accessibilityState={{ selected: reason === choice.code }}
        onPress={() => setReason(choice.code)}
        style={[styles.chip, reason === choice.code ? styles.chipSelected : null]}
      ><Text maxFontSizeMultiplier={CHIP_MAX_FONT_SCALE} style={[styles.chipText, reason === choice.code ? styles.chipTextSelected : null]}>{choice.label}</Text></Pressable>)}</View>
      <TextInput accessibilityLabel="Report details (optional)" placeholder="Add details (optional)" placeholderTextColor={colors.textFaint} value={note} onChangeText={setNote} maxLength={500} multiline style={styles.input} />
      <Text style={styles.caption}>Moderators see who reported. The author is not told. The message stays until a moderator acts.</Text>
      <PrimaryButton label="Send report" loading={saving} disabled={!reason} onPress={() => void submit()} />
      <SecondaryButton label="Cancel report" onPress={() => { setOpen(false); setReason(null); setNote(''); }} />
    </View> : <View style={styles.actions}>
      <LinkButton label="Report message" onPress={() => { setOpen(true); setStatus(null); }} />
      {canBlock ? <LinkButton label="Block author" onPress={() => setConfirmingBlock(true)} /> : null}
    </View>}
    <ConfirmDialog
      visible={confirmingBlock}
      title="Block this member?"
      message="You will stop seeing their messages in this organization’s team and event channels. Staff still see everything, and you can unblock them from Conversations › Safety."
      confirmLabel="Block member"
      onCancel={() => setConfirmingBlock(false)}
      onConfirm={() => { setConfirmingBlock(false); void block(); }}
    />
    {status ? <Text accessibilityRole="alert" style={styles.caption}>{status}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  panel: { gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  heading: { ...type.body, color: colors.text },
  reasons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingVertical: spacing.xs, paddingHorizontal: spacing.sm },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...type.caption, color: colors.text },
  chipTextSelected: { color: colors.white },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.sm, color: colors.text, minHeight: 60 },
  caption: { ...type.caption, color: colors.textMuted },
});
