import { shouldShowPhase3SurfaceHarness } from '../phase3Harness';

describe('Phase 3 surface harness gate', () => {
  test('requires both a development build and an explicit opt-in', () => {
    expect(shouldShowPhase3SurfaceHarness(true, 'true')).toBe(true);
    expect(shouldShowPhase3SurfaceHarness(true, undefined)).toBe(false);
    expect(shouldShowPhase3SurfaceHarness(true, 'false')).toBe(false);
  });

  test('cannot render in a production build even when requested', () => {
    expect(shouldShowPhase3SurfaceHarness(false, 'true')).toBe(false);
  });
});
