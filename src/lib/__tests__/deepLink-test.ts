import {
  captureInviteCodeFromUrl,
} from '../deepLink';

describe('deepLink', () => {
  it('parses query invite codes', () => {
    expect(
      captureInviteCodeFromUrl('teamhangout://join?code=abcd2345'),
    ).toBe('ABCD2345');
  });

  it('parses path invite codes', () => {
    expect(
      captureInviteCodeFromUrl('teamhangout://join/ZXCV9876'),
    ).toBe('ZXCV9876');
  });

  it('returns null for unrelated urls', () => {
    expect(captureInviteCodeFromUrl('teamhangout://home')).toBeNull();
    expect(captureInviteCodeFromUrl(':::')).toBeNull();
  });
});

  it('accepts urls without scheme prefix', () => {
    expect(captureInviteCodeFromUrl('join?code=AbCd2345')).toBe('ABCD2345');
  });
