import React, { useEffect, useState } from 'react';

import {
  AccessibilityInfo,
  ActivityIndicator,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  UIManager,
  View,
  ViewStyle,
} from 'react-native';

import {
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import {
  colors,
  fonts,
  radius,
  shadow,
  spacing,
  type,
} from '../theme/theme';

export type ScreenEdge = 'top' | 'bottom';

export function Screen({
  children,
  style,
  edges = ['top'],
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  edges?: ScreenEdge[];
}) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.screen,
        {
          paddingTop:
            spacing.lg + (edges.includes('top') ? insets.top : 0),
          paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

// 22pt headings already read large; past 2x a single word like "Household" no longer fits a phone line and wraps mid-word.
export const TITLE_MAX_FONT_SCALE = 2;
// Caps button labels so long words still fit on one line at the largest accessibility sizes.
export const BUTTON_MAX_FONT_SCALE = 1.5;
export const CHIP_MAX_FONT_SCALE = 1.3;

export function Title({ children }: { children: React.ReactNode }) {
  return <Text accessibilityRole="header" maxFontSizeMultiplier={TITLE_MAX_FONT_SCALE} style={styles.title}>{children}</Text>;
}

export function Subtitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.subtitle}>{children}</Text>;
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{message}</Text>;
}

export function TextField({
  error,
  ...props
}: TextInputProps & { error?: string }) {
  return (
    <View style={styles.fieldWrap}>
      <TextInput
        placeholderTextColor={colors.textFaint}
        style={[styles.input, error ? styles.inputError : null]}
        {...props}
      />
      <FieldError message={error} />
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  loading,
  disabled,
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      style={[
        styles.primaryButton,
        isDisabled ? styles.buttonDisabled : null,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={colors.white} />
      ) : (
        <Text maxFontSizeMultiplier={BUTTON_MAX_FONT_SCALE} style={styles.primaryButtonText}>{label}</Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  onPress,
  disabled,
  loading,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      style={[
        styles.secondaryButton,
        isDisabled ? styles.buttonDisabled : null,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <Text maxFontSizeMultiplier={BUTTON_MAX_FONT_SCALE} style={styles.secondaryButtonText}>{label}</Text>
      )}
    </Pressable>
  );
}

export type ConfirmCopy = {
  title: string;
  message: string;
  confirmLabel: string;
};

/** Modal that asks before an action that cannot be undone; only the red confirm button runs it. */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Keep it',
  onConfirm,
  onCancel,
}: ConfirmCopy & {
  visible: boolean;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.dialogBackdrop}>
        <View accessibilityViewIsModal style={styles.dialog}>
          {/* Scrolls so both buttons stay reachable when a long message meets large accessibility text. */}
          <ScrollView contentContainerStyle={styles.dialogContent}>
            <Text accessibilityRole="header" maxFontSizeMultiplier={TITLE_MAX_FONT_SCALE} style={styles.dialogTitle}>{title}</Text>
            <Text style={styles.dialogMessage}>{message}</Text>
            <DestructiveButton label={confirmLabel} onPress={onConfirm} />
            <SecondaryButton label={cancelLabel} onPress={onCancel} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Red button for actions that are hard or impossible to undo. With `confirm`, the press opens a
 * ConfirmDialog and `onPress` runs only after the person confirms.
 */
export function DestructiveButton({
  label,
  onPress,
  confirm,
  loading,
  disabled,
}: {
  label: string;
  onPress: () => void;
  confirm?: ConfirmCopy;
  loading?: boolean;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const isDisabled = disabled || loading;
  return (
    <>
      <Pressable
        onPress={() => (confirm ? setAsking(true) : onPress())}
        disabled={isDisabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={confirm ? 'Asks for confirmation first' : undefined}
        accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
        style={({ pressed }) => [
          styles.destructiveButton,
          pressed ? styles.destructivePressed : null,
          isDisabled ? styles.buttonDisabled : null,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={colors.white} />
        ) : (
          <Text maxFontSizeMultiplier={BUTTON_MAX_FONT_SCALE} style={styles.primaryButtonText}>{label}</Text>
        )}
      </Pressable>
      {confirm ? (
        <ConfirmDialog
          {...confirm}
          visible={asking}
          onCancel={() => setAsking(false)}
          onConfirm={() => { setAsking(false); onPress(); }}
        />
      ) : null}
    </>
  );
}

if (Platform.OS === 'android') UIManager.setLayoutAnimationEnabledExperimental?.(true);

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    void Promise.resolve(AccessibilityInfo.isReduceMotionEnabled()).then(value => { if (live) setReduced(!!value); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { live = false; sub?.remove(); };
  }, []);
  return reduced;
}

/** Disclosure section: a header row with a rotating chevron that shows or hides its content. */
export function Accordion({
  title,
  initiallyOpen = false,
  onToggle,
  children,
}: {
  title: string;
  initiallyOpen?: boolean;
  onToggle?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const reduced = useReducedMotion();
  const toggle = () => {
    const next = !open;
    // LayoutAnimation runs natively, so the body and chevron ease without driving JS frames.
    if (!reduced) LayoutAnimation.configureNext(LayoutAnimation.create(200, 'easeInEaseOut', 'opacity'));
    setOpen(next);
    onToggle?.(next);
  };
  return (
    <View style={styles.accordion}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.accordionHeader, pressed ? styles.accordionPressed : null]}
      >
        <Text maxFontSizeMultiplier={BUTTON_MAX_FONT_SCALE} style={styles.accordionTitle}>{title}</Text>
        <Text importantForAccessibility="no" accessibilityElementsHidden maxFontSizeMultiplier={BUTTON_MAX_FONT_SCALE} style={[styles.accordionChevron, open ? styles.accordionChevronOpen : null]}>⌄</Text>
      </Pressable>
      {open ? <View style={styles.accordionBody}>{children}</View> : null}
    </View>
  );
}

export function LinkButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.linkButton}>
      <Text maxFontSizeMultiplier={BUTTON_MAX_FONT_SCALE} style={styles.linkText}>{label}</Text>
    </Pressable>
  );
}

export function ConsentCheckbox({
  checked,
  onToggle,
  label,
  error,
}: {
  checked: boolean;
  onToggle: () => void;
  label: React.ReactNode;
  error?: string;
}) {
  return (
    <View style={styles.consentWrap}>
      <Pressable
        onPress={onToggle}
        style={styles.consentRow}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
      >
        <View
          style={[
            styles.checkbox,
            checked ? styles.checkboxChecked : null,
          ]}
        >
          {checked ? (
            <Text style={styles.checkboxMark}>✓</Text>
          ) : null}
        </View>
        <View style={styles.consentLabel}>{label}</View>
      </Pressable>
      <FieldError message={error} />
    </View>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
  },
  title: {
    ...type.h1,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  subtitle: {
    ...type.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  label: {
    ...type.label,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  fieldWrap: {
    marginBottom: spacing.md,
  },
  input: {
    ...type.body,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.text,
  },
  inputError: {
    borderColor: colors.danger,
  },
  error: {
    ...type.caption,
    color: colors.danger,
    marginTop: spacing.xs,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
    ...shadow.button,
  },
  primaryButtonText: {
    fontFamily: fonts.semiBold,
    fontSize: 16,
    color: colors.white,
  },
  secondaryButton: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  secondaryButtonText: {
    fontFamily: fonts.semiBold,
    fontSize: 16,
    color: colors.primary,
  },
  destructiveButton: {
    backgroundColor: colors.danger,
    borderRadius: radius.md,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  destructivePressed: {
    backgroundColor: colors.dangerPressed,
  },
  dialogBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xxl,
  },
  dialog: {
    maxHeight: '100%',
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    overflow: 'hidden',
    ...shadow.card,
  },
  dialogContent: {
    padding: spacing.lg,
  },
  dialogTitle: {
    ...type.h2,
    color: colors.danger,
    marginBottom: spacing.sm,
  },
  dialogMessage: {
    ...type.body,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  accordion: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  accordionHeader: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  accordionPressed: {
    backgroundColor: colors.primarySoft,
  },
  accordionTitle: {
    fontFamily: fonts.semiBold,
    fontSize: 16,
    color: colors.primary,
    flex: 1,
  },
  accordionChevron: {
    fontFamily: fonts.bold,
    fontSize: 20,
    lineHeight: 22,
    color: colors.primary,
  },
  accordionChevronOpen: {
    transform: [{ rotate: '180deg' }],
  },
  accordionBody: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  linkButton: {
    minHeight: 44,
    justifyContent: 'center',
    marginTop: spacing.md,
    alignItems: 'center',
    padding: spacing.sm,
  },
  linkText: {
    ...type.bodyMedium,
    color: colors.primaryLight,
  },
  consentWrap: {
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  consentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkboxMark: {
    color: colors.white,
    fontSize: 14,
    fontFamily: fonts.bold,
    lineHeight: 16,
  },
  consentLabel: {
    flex: 1,
  },
  empty: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
  },
  emptyText: {
    ...type.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
