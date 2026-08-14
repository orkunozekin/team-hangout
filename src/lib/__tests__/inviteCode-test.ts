import {
  buildInviteDeepLink,
  generateInviteCode,
  INVITE_CODE_LENGTH,
  isValidInviteCodeFormat,
  memberDocId,
  normalizeInviteCode,
} from '../inviteCode';

describe('inviteCode', () => {
  it('generates an 8-character code from alphabet', () => {
    let i = 0;
    const code = generateInviteCode(() => {
      const values = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
      return values[i++] ?? 0;
    });
    expect(code).toHaveLength(INVITE_CODE_LENGTH);
    expect(code).toMatch(/^[A-Z0-9]+$/);
  });

  it('normalizes invite codes', () => {
    expect(normalizeInviteCode(' ab-cd_12 ')).toBe('ABCD12');
  });

  it('validates invite code format', () => {
    expect(isValidInviteCodeFormat('ABCD2345')).toBe(true);
    expect(isValidInviteCodeFormat('short')).toBe(false);
    expect(isValidInviteCodeFormat('TOOLONG12')).toBe(false);
  });

  it('builds deep links', () => {
    expect(buildInviteDeepLink('abcd2345')).toBe(
      'teamhangout://join?code=ABCD2345',
    );
  });

  it('builds member doc ids', () => {
    expect(memberDocId('team1', 'user1')).toBe('team1_user1');
  });
});
