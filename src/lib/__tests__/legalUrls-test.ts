import {
  getLegalUrls,
  hasAnyLegalUrl,
  LegalUrls,
} from '../legalUrls';

describe('legalUrls', () => {
  const original = {
    privacy: process.env.EXPO_PUBLIC_PRIVACY_URL,
    terms: process.env.EXPO_PUBLIC_TERMS_URL,
    support: process.env.EXPO_PUBLIC_SUPPORT_URL,
  };

  afterEach(() => {
    process.env.EXPO_PUBLIC_PRIVACY_URL = original.privacy;
    process.env.EXPO_PUBLIC_TERMS_URL = original.terms;
    process.env.EXPO_PUBLIC_SUPPORT_URL = original.support;
  });

  it('returns null for empty or whitespace URLs', () => {
    process.env.EXPO_PUBLIC_PRIVACY_URL = '  ';
    process.env.EXPO_PUBLIC_TERMS_URL = '';
    delete process.env.EXPO_PUBLIC_SUPPORT_URL;

    expect(getLegalUrls()).toEqual({
      privacy: null,
      terms: null,
      support: null,
    });
  });

  it('trims and returns configured URLs', () => {
    process.env.EXPO_PUBLIC_PRIVACY_URL = ' https://example.com/privacy ';
    process.env.EXPO_PUBLIC_TERMS_URL = 'https://example.com/terms';
    process.env.EXPO_PUBLIC_SUPPORT_URL = 'https://example.com/support';

    expect(getLegalUrls()).toEqual({
      privacy: 'https://example.com/privacy',
      terms: 'https://example.com/terms',
      support: 'https://example.com/support',
    });
  });

  it('detects whether any legal URL is set', () => {
    const none: LegalUrls = {
      privacy: null,
      terms: null,
      support: null,
    };
    expect(hasAnyLegalUrl(none)).toBe(false);
    expect(
      hasAnyLegalUrl({
        ...none,
        privacy: 'https://example.com/privacy',
      }),
    ).toBe(true);
  });
});
