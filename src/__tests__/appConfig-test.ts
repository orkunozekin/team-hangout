import appConfig from '../../app.config';

const resolve = (variant?: string) => {
  const previous = process.env.APP_VARIANT;
  process.env.APP_VARIANT = variant;
  try {
    return appConfig({ config: {} } as never);
  } finally {
    process.env.APP_VARIANT = previous;
  }
};

describe('app config', () => {
  it('uses the production push entitlement and drops expo-dev-client for store builds', () => {
    const config = resolve('production');

    expect(config.ios?.entitlements?.['aps-environment']).toBe('production');
    expect(config.plugins).not.toContain('expo-dev-client');
  });

  it('declares every data type the shipped app collects in the privacy manifest', () => {
    const declared = resolve('production').ios?.privacyManifests?.NSPrivacyCollectedDataTypes
      ?.map((entry) => entry.NSPrivacyCollectedDataType);

    expect(declared).toEqual(expect.arrayContaining([
      'NSPrivacyCollectedDataTypeEmailAddress',
      'NSPrivacyCollectedDataTypeName',
      'NSPrivacyCollectedDataTypeUserID',
      'NSPrivacyCollectedDataTypePhoneNumber',
      'NSPrivacyCollectedDataTypePhotosorVideos',
      'NSPrivacyCollectedDataTypePreciseLocation',
      'NSPrivacyCollectedDataTypeDeviceID',
      'NSPrivacyCollectedDataTypeOtherUserContent',
    ]));
  });
});
