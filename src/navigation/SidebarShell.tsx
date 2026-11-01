import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  BackHandler,
  Easing,
  findNodeHandle,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  SafeAreaInsetsContext,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts, spacing } from '../theme/theme';

export type SidebarItem = {
  key: string;
  label: string;
  icon: string;
};

export const SIDEBAR_OPEN_MS = 260;
export const SIDEBAR_CLOSE_MS = 200;
const MAX_PANEL_WIDTH = 320;

export function sidebarDuration(open: boolean, reduceMotion: boolean) {
  if (reduceMotion) return 0;
  return open ? SIDEBAR_OPEN_MS : SIDEBAR_CLOSE_MS;
}

function useReduceMotion() {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then(value => { if (active) setReduceMotion(value); })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { active = false; sub.remove(); };
  }, []);
  return reduceMotion;
}

function focus(ref: React.RefObject<View | null>) {
  const node = ref.current ? findNodeHandle(ref.current) : null;
  if (node) AccessibilityInfo.setAccessibilityFocus(node);
}

export default function SidebarShell({
  items,
  activeKey,
  title,
  onSelect,
  children,
}: {
  items: SidebarItem[];
  activeKey: string;
  title: string;
  onSelect: (key: string) => void;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(MAX_PANEL_WIDTH, Math.round(width * 0.82));
  const reduceMotion = useReduceMotion();
  const [open, setOpen] = useState(false);
  // Keeps the panel mounted while the close animation finishes.
  const [visible, setVisible] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const toggleRef = useRef<View>(null);
  const firstItemRef = useRef<View>(null);

  useEffect(() => {
    if (open) setVisible(true);
    const animation = Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: sidebarDuration(open, reduceMotion),
      easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (!finished) return;
      if (open) focus(firstItemRef);
      else { setVisible(false); focus(toggleRef); }
    });
    return () => animation.stop();
  }, [open, progress, reduceMotion]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setOpen(false); return true; });
    return () => sub.remove();
  }, [open]);

  const select = useCallback((key: string) => {
    setOpen(false);
    onSelect(key);
  }, [onSelect]);

  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [-panelWidth, 0] });

  return (
    <View style={styles.root}>
      <View
        style={styles.root}
        importantForAccessibility={open ? 'no-hide-descendants' : 'auto'}
        accessibilityElementsHidden={open}
      >
        <View style={[styles.bar, { paddingTop: insets.top + spacing.sm }]}>
          <Pressable
            ref={toggleRef}
            testID="sidebar-toggle"
            accessibilityRole="button"
            accessibilityLabel={open ? 'Close navigation menu' : 'Open navigation menu'}
            accessibilityState={{ expanded: open }}
            hitSlop={8}
            onPress={() => setOpen(value => !value)}
            style={styles.toggle}
          >
            <Ionicons name="menu" size={26} color={colors.primary} />
          </Pressable>
          <Text accessibilityRole="header" style={styles.barTitle} numberOfLines={1}>{title}</Text>
        </View>
        {/* The bar already clears the top inset, so screens below must not pad for it again. */}
        <SafeAreaInsetsContext.Provider value={{ ...insets, top: 0 }}>
          <View style={styles.root}>{children}</View>
        </SafeAreaInsetsContext.Provider>
      </View>
      {visible ? (
        <View style={StyleSheet.absoluteFill} pointerEvents={open ? 'auto' : 'none'}>
          <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: progress }]}>
            <Pressable
              testID="sidebar-backdrop"
              accessibilityRole="button"
              accessibilityLabel="Close navigation menu"
              style={StyleSheet.absoluteFill}
              onPress={() => setOpen(false)}
            />
          </Animated.View>
          <Animated.View
            accessibilityViewIsModal
            onAccessibilityEscape={() => setOpen(false)}
            accessibilityLabel="Navigation menu"
            style={[
              styles.panel,
              { width: panelWidth, paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.md, transform: [{ translateX }] },
            ]}
          >
            <Text style={styles.brand}>Team Hangout</Text>
            <ScrollView>
            {items.map((item, index) => {
              const active = item.key === activeKey;
              return (
                <Pressable
                  key={item.key}
                  ref={index === 0 ? firstItemRef : undefined}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => select(item.key)}
                  style={({ pressed }) => [styles.item, active && styles.itemActive, pressed && styles.itemPressed]}
                >
                  <Ionicons name={item.icon as never} size={22} color={active ? colors.primary : colors.textMuted} />
                  <Text style={[styles.itemLabel, active && styles.itemLabelActive]}>{item.label}</Text>
                </Pressable>
              );
            })}
            </ScrollView>
          </Animated.View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  toggle: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -spacing.sm },
  barTitle: { flex: 1, fontFamily: fonts.semiBold, fontSize: 17, color: colors.text, marginLeft: spacing.xs },
  backdrop: { backgroundColor: colors.overlay },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.card,
    paddingHorizontal: spacing.md,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 4, height: 0 },
    elevation: 12,
  },
  brand: { fontFamily: fonts.bold, fontSize: 20, color: colors.primary, marginBottom: spacing.lg, marginLeft: spacing.sm },
  item: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: spacing.sm, borderRadius: 10, marginBottom: 2 },
  itemActive: { backgroundColor: colors.primarySoft },
  itemPressed: { opacity: 0.7 },
  itemLabel: { marginLeft: spacing.md, fontFamily: fonts.medium, fontSize: 16, color: colors.text },
  itemLabelActive: { fontFamily: fonts.semiBold, color: colors.primary },
});
