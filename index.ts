import 'react-native-gesture-handler';

import { registerRootComponent } from 'expo';

import { shouldShowPhase3SurfaceHarness } from './src/lib/phase3Harness';

const RootComponent = shouldShowPhase3SurfaceHarness(
  __DEV__,
  process.env.EXPO_PUBLIC_PHASE3_SURFACE_HARNESS,
)
  ? require('./src/Phase3SurfaceHarnessApp').default
  : require('./App').default;

registerRootComponent(RootComponent);
