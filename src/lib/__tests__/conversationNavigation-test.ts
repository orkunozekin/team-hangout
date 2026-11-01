import { householdConversationTargets, teamConversationTargets, eventConversationTarget } from '../conversationNavigation';

const household = [{ orgId: 'org', participantId: 'jamie', displayName: 'Jamie' }];
const stars = {
  id: 'stars', orgId: 'org', organizationName: 'Demo Club', name: 'Stars',
  seasonId: 'fall', seasonName: 'Fall', seasonStatus: 'active' as const, archived: false,
  divisionId: 'u12', divisionName: 'U12', participants: household,
};
const comets = { ...stars, id: 'comets', name: 'Comets' };
const other = { ...stars, id: 'hawks', orgId: 'other', organizationName: 'Other Club', name: 'Hawks', divisionId: 'u10', divisionName: 'U10' };

test('household targets keep one announcement per organization and division and one channel per team and event', () => {
  const targets = householdConversationTargets([stars, comets, other], [
    { id: 'practice', orgId: 'org', title: 'Sibling practice' },
    { id: 'practice', orgId: 'org', title: 'Sibling practice' },
  ]);
  expect(targets.map(target => target.label)).toEqual([
    'Demo Club announcements',
    'U12 announcements',
    'Stars',
    'Comets',
    'Other Club announcements',
    'U10 announcements',
    'Hawks',
    'Sibling practice',
  ]);
  expect(targets.find(target => target.scopeType === 'division' && target.scopeId === 'u12')).toMatchObject({ orgId: 'org' });
  expect(targets.filter(target => target.scopeType === 'team')).toHaveLength(3);
});

test('a household team without a division still opens its organization and team channels', () => {
  const { divisionId: _division, divisionName: _name, ...team } = stars;
  expect(householdConversationTargets([team], []).map(target => target.scopeType)).toEqual(['organization', 'team']);
});

test('a division without a display name still opens one announcement', () => {
  const { divisionName: _name, ...team } = stars;
  expect(householdConversationTargets([team], []).find(target => target.scopeType === 'division')?.label).toBe('Division announcements');
});

test('a coach-only team opens its team channel and not family announcements', () => {
  expect(householdConversationTargets([{ ...stars, id: 'coach', participants: [] }], []).map(target => target.scopeType)).toEqual(['team']);
});

test('canonical team navigation opens the team channel and skips legacy teams', () => {
  expect(teamConversationTargets({ id: 'stars', name: 'Stars', schemaVersion: 2, orgId: 'org' })).toEqual([
    { orgId: 'org', scopeType: 'team', scopeId: 'stars', label: 'Stars' },
  ]);
  expect(teamConversationTargets({ id: 'legacy', name: 'Legacy', orgId: 'org' })).toEqual([]);
  expect(teamConversationTargets({ id: 'stars', name: 'Stars', schemaVersion: 2 })).toEqual([]);
});

test('event navigation uses the event organization and stays closed without it', () => {
  expect(eventConversationTarget({ id: 'shared', schemaVersion: 2, orgId: 'org' })).toMatchObject({ scopeType: 'event', scopeId: 'shared', orgId: 'org' });
  expect(eventConversationTarget({ id: 'legacy', schemaVersion: 1, orgId: 'org' })).toBeNull();
});
