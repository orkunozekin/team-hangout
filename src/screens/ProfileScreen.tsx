import React, {
  useState,
} from 'react';

import {
  Alert,
  ScrollView,
} from 'react-native';

import {
  User,
} from 'firebase/auth';

import {
  logout,
} from '../api/auth';

import {
  updateUserDisplayName,
} from '../firebase/users';

import {
  FieldLabel,
  PrimaryButton,
  Screen,
  SecondaryButton,
  Subtitle,
  TextField,
  Title,
} from '../components/ui';

import {
  AppRole,
  Team,
  TeamMember,
} from '../types/models';

import {
  isSuperAdminRole,
} from '../lib/roles';

type Props = {
  user: User;
  team: Team | null;
  membership: TeamMember | null;
  appRole?: AppRole;
};

export default function ProfileScreen({
  user,
  team,
  membership,
  appRole,
}: Props) {
  const [displayName, setDisplayName] = useState(
    user.displayName || membership?.displayName || '',
  );
  const [loading, setLoading] = useState(false);
  const isSuperAdmin = isSuperAdminRole(appRole);

  async function onSave() {
    const trimmed = displayName.trim();
    if (trimmed.length < 2) {
      Alert.alert('Display name must be at least 2 characters');
      return;
    }

    setLoading(true);
    try {
      await updateUserDisplayName(user.uid, trimmed);
      Alert.alert('Saved', 'Profile updated.');
    } catch (err) {
      Alert.alert(
        'Could not save',
        err instanceof Error ? err.message : 'Please try again',
      );
    } finally {
      setLoading(false);
    }
  }

  async function onLogout() {
    try {
      await logout();
    } catch (err) {
      Alert.alert(
        'Logout failed',
        err instanceof Error ? err.message : 'Please try again',
      );
    }
  }

  return (
    <Screen>
      <ScrollView>
        <Title>Profile</Title>
        <Subtitle>
          {isSuperAdmin ? 'Super Admin · ' : ''}
          {team
            ? `${team.name} · ${membership?.role ?? 'member'}`
            : 'No team selected'}
        </Subtitle>

        <FieldLabel>Email</FieldLabel>
        <TextField value={user.email ?? ''} editable={false} />

        <FieldLabel>Display name</FieldLabel>
        <TextField
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="Your name"
        />

        <PrimaryButton
          label="Save profile"
          onPress={onSave}
          loading={loading}
        />

        <SecondaryButton label="Sign out" onPress={onLogout} />
      </ScrollView>
    </Screen>
  );
}
