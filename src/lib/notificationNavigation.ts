export type PendingNotificationTarget = {
  notificationId: string;
  sourceRevision: number;
};

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function notificationTargetUrl(target: PendingNotificationTarget): string {
  return `teamhangout://notification?id=${encodeURIComponent(target.notificationId)}&revision=${target.sourceRevision}`;
}

export function notificationTargetFromUrl(url: string): PendingNotificationTarget | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'teamhangout:' || parsed.hostname !== 'notification' || parsed.pathname !== '') return null;
    const notificationId = parsed.searchParams.get('id') ?? '';
    const sourceRevision = Number(parsed.searchParams.get('revision'));
    if (!ID.test(notificationId) || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1) return null;
    return { notificationId, sourceRevision };
  } catch {
    return null;
  }
}

export function notificationTargetFromData(data: unknown): PendingNotificationTarget | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const url = (data as { url?: unknown }).url;
  return typeof url === 'string' ? notificationTargetFromUrl(url) : null;
}

export function notificationDestination(currentTeamId: string | null, targetTeamId: string | null): 'event' | 'household' {
  return currentTeamId != null && targetTeamId === currentTeamId ? 'event' : 'household';
}
