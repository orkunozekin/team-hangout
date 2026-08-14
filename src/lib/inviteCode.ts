const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 8;

export function generateInviteCode(
  random: () => number = Math.random,
): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
    const index = Math.floor(random() * ALPHABET.length);
    code += ALPHABET[index];
  }
  return code;
}

export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidInviteCodeFormat(code: string): boolean {
  const normalized = normalizeInviteCode(code);
  return (
    normalized.length === INVITE_CODE_LENGTH &&
    /^[A-Z0-9]+$/.test(normalized)
  );
}

export function buildInviteDeepLink(code: string): string {
  const normalized = normalizeInviteCode(code);
  return `teamhangout://join?code=${normalized}`;
}

export function memberDocId(teamId: string, userId: string): string {
  return `${teamId}_${userId}`;
}
