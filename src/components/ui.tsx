import React from 'react';

import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
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
