/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|firebase|@firebase/.*)',
  ],
  collectCoverageFrom: [
    'src/api/**/*.{ts,tsx}',
    'src/firebase/**/*.{ts,tsx}',
    'src/lib/**/*.{ts,tsx}',
    '!src/firebase/config.ts',
  ],
  coveragePathIgnorePatterns: ['/node_modules/', '/coverage/'],
  coverageThreshold: {
    './src/api/': {
      statements: 85,
      branches: 80,
      functions: 85,
      lines: 85,
    },
    './src/firebase/': {
      statements: 85,
      branches: 80,
      functions: 85,
      lines: 85,
    },
    './src/lib/': {
      statements: 85,
      branches: 85,
      functions: 85,
      lines: 85,
    },
  },
};
