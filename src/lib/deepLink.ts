export function captureInviteCodeFromUrl(url: string): string | null {
  try {
    const withProtocol = url.includes('://')
      ? url
      : `teamhangout://${url}`;
    const normalized = withProtocol.replace(
      /^teamhangout:\/\//i,
      'https://teamhangout.local/',
    );
    const parsed = new URL(normalized);
    const fromQuery = parsed.searchParams.get('code');
    if (fromQuery) {
      return fromQuery.trim().toUpperCase();
    }

    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const joinIndex = pathParts.findIndex(
      (part) => part.toLowerCase() === 'join',
    );
    if (joinIndex >= 0 && pathParts[joinIndex + 1]) {
      return pathParts[joinIndex + 1].trim().toUpperCase();
    }

    return null;
  } catch {
    return null;
  }
}
