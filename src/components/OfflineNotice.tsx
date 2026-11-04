import React from "react";
import { StyleSheet, Text } from "react-native";
import { colors, radius, spacing, type } from "../theme/theme";

export default function OfflineNotice({
  savedAt,
  olderThanTtl,
}: {
  savedAt: string;
  olderThanTtl: boolean;
}) {
  const label = new Date(savedAt).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <Text
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={styles.notice}
    >
      Offline copy from {label}. Details may be outdated.
      {olderThanTtl ? " This copy is more than 24 hours old." : ""}
    </Text>
  );
}

const styles = StyleSheet.create({
  notice: {
    ...type.bodyMedium,
    color: colors.warning,
    backgroundColor: colors.warningBg,
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginVertical: spacing.md,
  },
});
