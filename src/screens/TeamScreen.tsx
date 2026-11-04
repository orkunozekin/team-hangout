import React, {
  useCallback,
  useState,
  useRef,
} from 'react';

import {
  Alert,
  FlatList,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  useFocusEffect,
} from '@react-navigation/native';

import {
  getTeam,
  listTeamMembers,
  regenerateInviteCode,
} from '../firebase/teams';

import {
  buildInviteDeepLink,
} from '../lib/inviteCode';

import {
  canManageTeam,
  displayTeamRole,
  isSuperAdminRole,
} from '../lib/roles';

import {
  DestructiveButton,
  EmptyState,
  PrimaryButton,
  Screen,
  SecondaryButton,
  Subtitle,
  Title,
} from '../components/ui';

import {
  AppRole,
  Team,
  TeamMember,
} from '../types/models';

import {
  colors,
  fonts,
  radius,
  spacing,
  type,
} from '../theme/theme';
import { TeamReportSummary } from '../components/TeamReportSummary';

type Props = {
  teamId: string;
  membership: TeamMember;
  appRole?: AppRole;
};

export default function TeamScreen({ teamId, membership, appRole }: Props) {
  const [team, setTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingCode, setLoadingCode] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const request = useRef(0);
  const canManage = canManageTeam({ membership, appRole });
  const isSuperAdmin = isSuperAdminRole(appRole);

  const load = useCallback(async () => {
    const current = ++request.current;
    setLoadError(null);
    setTeam(null);
    setMembers([]);
    try {
      const teamData = await getTeam(teamId);
      if (!teamData) throw new Error('Team unavailable');
      const memberData = teamData.schemaVersion === 2 ? [] : await listTeamMembers(teamId);
      if (current !== request.current) return;
      setTeam(teamData);
      setMembers(memberData);
    } catch {
      if (current === request.current) setLoadError('Unable to load this team. Please try again.');
    }
  }, [teamId]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return () => { request.current++; };
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  async function onShareInvite() {
    if (!team) return;
    const link = buildInviteDeepLink(team.inviteCode);
    await Share.share({
      message: `Join ${team.name} on Team Hangout!\nCode: ${team.inviteCode}\n${link}`,
    });
  }

  async function onRegenerate() {
    setLoadingCode(true);
    try {
      const result = await regenerateInviteCode({
        teamId,
        userId: membership.userId,
        isSuperAdmin,
      });
      setTeam((prev) =>
        prev
          ? { ...prev, inviteCode: result.inviteCode }
          : prev,
      );
    } catch (err) {
      Alert.alert(
        'Failed',
        err instanceof Error ? err.message : 'Please try again',
      );
    } finally {
      setLoadingCode(false);
    }
  }

  return (
    <Screen style={{ paddingHorizontal: 0 }}>
      <View style={styles.header}>
        <Title>{team?.name ?? 'Team'}</Title>
        <Subtitle>
          {team?.sport ? `${team.sport} · ` : ''}
          Your role: {displayTeamRole(membership, appRole)}
        </Subtitle>

        {canManage && team && team.schemaVersion !== 2 ? (
          <View style={styles.inviteBox}>
            <Text style={styles.inviteLabel}>Invite code</Text>
            <Text style={styles.inviteCode}>{team.inviteCode}</Text>
            <PrimaryButton label="Share invite" onPress={onShareInvite} />
            <DestructiveButton
              label={loadingCode ? 'Working...' : 'Regenerate code'}
              confirm={{
                title: 'Regenerate invite code?',
                message: 'The old code will stop working immediately.',
                confirmLabel: 'Regenerate',
              }}
              onPress={() => void onRegenerate()}
              disabled={loadingCode}
            />
          </View>
        ) : null}
      </View>

      {loadError ? (
        <View style={styles.list}>
          <Text accessibilityRole="alert">{loadError}</Text>
          <SecondaryButton label="Retry" onPress={load} />
        </View>
      ) : !team ? (
        <EmptyState message="Loading team..." />
      ) : team.schemaVersion === 2 ? (
        <ScrollView contentContainerStyle={styles.list}>
          <Text>Your organization manages this team's roster.</Text>
          <SecondaryButton label="Refresh team" onPress={onRefresh} disabled={refreshing} />
          {membership.role === 'coach' && team.orgId && team.programId && team.seasonId ? (
            <TeamReportSummary orgId={team.orgId} programId={team.programId} seasonId={team.seasonId} teamId={team.id} />
          ) : null}
        </ScrollView>
      ) : (
        <>
          <Text style={styles.sectionTitle}>Members ({members.length})</Text>

          <FlatList
            data={members}
            keyExtractor={(item) => item.id}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <EmptyState message="No members yet." />
            }
            renderItem={({ item }) => (
              <View style={styles.memberRow}>
                <View>
                  <Text style={styles.memberName}>{item.displayName}</Text>
                  <Text style={styles.memberRole}>{displayTeamRole(item)}</Text>
                </View>
              </View>
            )}
          />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.lg,
  },
  inviteBox: {
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  inviteLabel: {
    ...type.label,
    color: colors.primary,
    marginBottom: spacing.xs,
  },
  inviteCode: {
    fontFamily: fonts.bold,
    fontSize: 28,
    letterSpacing: 2,
    color: colors.primaryDark,
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    ...type.h2,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  memberRow: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  memberName: {
    fontFamily: fonts.semiBold,
    fontSize: 16,
    color: colors.text,
  },
  memberRole: {
    ...type.caption,
    color: colors.textMuted,
    textTransform: 'capitalize',
    marginTop: 2,
  },
});
