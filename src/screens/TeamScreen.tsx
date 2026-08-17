import React, {
  useCallback,
  useState,
} from 'react';

import {
  Alert,
  FlatList,
  RefreshControl,
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
  const canManage = canManageTeam({ membership, appRole });
  const isSuperAdmin = isSuperAdminRole(appRole);

  const load = useCallback(async () => {
    const [teamData, memberData] = await Promise.all([
      getTeam(teamId),
      listTeamMembers(teamId),
    ]);
    setTeam(teamData);
    setMembers(memberData);
  }, [teamId]);

  useFocusEffect(
    useCallback(() => {
      load();
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
    Alert.alert(
      'Regenerate invite code?',
      'The old code will stop working immediately.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Regenerate',
          style: 'destructive',
          onPress: async () => {
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
          },
        },
      ],
    );
  }

  return (
    <Screen style={{ paddingHorizontal: 0 }}>
      <View style={styles.header}>
        <Title>{team?.name ?? 'Team'}</Title>
        <Subtitle>
          {team?.sport ? `${team.sport} · ` : ''}
          Your role: {displayTeamRole(membership.role, appRole)}
        </Subtitle>

        {canManage && team ? (
          <View style={styles.inviteBox}>
            <Text style={styles.inviteLabel}>Invite code</Text>
            <Text style={styles.inviteCode}>{team.inviteCode}</Text>
            <PrimaryButton label="Share invite" onPress={onShareInvite} />
            <SecondaryButton
              label={loadingCode ? 'Working...' : 'Regenerate code'}
              onPress={onRegenerate}
              disabled={loadingCode}
            />
          </View>
        ) : null}
      </View>

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
              <Text style={styles.memberRole}>{item.role}</Text>
            </View>
          </View>
        )}
      />
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
