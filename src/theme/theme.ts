export const colors = {
  primary: '#0F3D2E',
  primaryDark: '#0A2A20',
  primaryLight: '#1B5E45',
  primarySoft: '#E6F2ED',

  accent: '#E8A838',
  accentSoft: '#FFF6E5',

  background: '#F7F5F2',
  backgroundWarm: '#F7F5F2',
  card: '#FFFFFF',
  border: '#E4DFD8',
  borderStrong: '#CFC7BC',

  text: '#1A1A1A',
  textMuted: '#6B6560',
  textFaint: '#9A938A',

  success: '#1E8E5A',
  successBg: '#E7F7EE',
  warning: '#B76E00',
  warningBg: '#FFF4E0',
  danger: '#C62828',
  dangerBg: '#FDECEA',

  practice: '#1B5E45',
  practiceBg: '#E6F2ED',
  match: '#1A4A7A',
  matchBg: '#E8F1F8',

  white: '#FFFFFF',
  overlay: 'rgba(26, 26, 26, 0.5)',
};

export const fonts = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semiBold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
};

export const type = {
  display: { fontFamily: fonts.bold, fontSize: 30, lineHeight: 36 },
  h1: { fontFamily: fonts.bold, fontSize: 22, lineHeight: 28 },
  h2: { fontFamily: fonts.bold, fontSize: 18, lineHeight: 24 },
  body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 21 },
  bodyMedium: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 21 },
  label: { fontFamily: fonts.semiBold, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: fonts.medium, fontSize: 12, lineHeight: 16 },
  tiny: { fontFamily: fonts.semiBold, fontSize: 10, lineHeight: 13 },
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const radius = {
  sm: 10,
  md: 14,
  lg: 20,
  full: 999,
};

export const shadow = {
  card: {
    shadowColor: '#1A1A1A',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.06,
    shadowRadius: 16,
    elevation: 3,
  },
  button: {
    shadowColor: '#0F3D2E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 2,
  },
};
