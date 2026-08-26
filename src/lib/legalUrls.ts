export type LegalUrls = {
  privacy: string | null;
  terms: string | null;
  support: string | null;
};

function readUrl(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

export function getLegalUrls(): LegalUrls {
  return {
    privacy: readUrl(process.env.EXPO_PUBLIC_PRIVACY_URL),
    terms: readUrl(process.env.EXPO_PUBLIC_TERMS_URL),
    support: readUrl(process.env.EXPO_PUBLIC_SUPPORT_URL),
  };
}

export function hasAnyLegalUrl(urls: LegalUrls = getLegalUrls()): boolean {
  return Boolean(urls.privacy || urls.terms || urls.support);
}
