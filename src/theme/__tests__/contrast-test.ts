import { colors } from "../theme";
function luminance(hex: string) {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return channels.reduce(
    (sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i],
    0,
  );
}
it.each([
  ["placeholder", colors.textFaint, colors.card],
  ["muted copy", colors.textMuted, colors.background],
  ["success status", colors.success, colors.successBg],
  ["warning status", colors.warning, colors.warningBg],
  ["error", colors.danger, colors.dangerBg],
])(
  "%s maintains 4.5:1 contrast for normal text",
  (_, foreground, background) => {
    const [low, high] = [luminance(foreground), luminance(background)].sort(
      (a, b) => a - b,
    );
    expect((high + 0.05) / (low + 0.05)).toBeGreaterThanOrEqual(4.5);
  },
);
