import {
  notificationTargetFromData,
  notificationTargetFromUrl,
  notificationTargetUrl,
} from '../notificationNavigation';

describe('notification navigation', () => {
  const target = {
    notificationId: 'notice_123',
    sourceRevision: 4,
  };

  it('round trips only the allowlisted notification route', () => {
    const url = notificationTargetUrl(target);
    expect(url).toBe('teamhangout://notification?id=notice_123&revision=4');
    expect(notificationTargetFromUrl(url)).toEqual(target);
    expect(notificationTargetFromData({ url })).toEqual(target);
  });

  it('rejects arbitrary, malformed and unsupported targets', () => {
    expect(notificationTargetFromUrl('https://example.test/steal')).toBeNull();
    expect(notificationTargetFromUrl('teamhangout://notification?id=../event&revision=4')).toBeNull();
    expect(notificationTargetFromUrl('teamhangout://notification?id=notice_123&revision=0')).toBeNull();
    expect(notificationTargetFromData({ url: 42 })).toBeNull();
    expect(notificationTargetFromData({ targetType: 'url', targetId: 'https://example.test' })).toBeNull();
  });
});
