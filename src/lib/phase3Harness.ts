export function shouldShowPhase3SurfaceHarness(isDevelopment: boolean, requested: string | undefined): boolean {
  return isDevelopment && requested === 'true';
}
