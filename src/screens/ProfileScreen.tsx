import React, {
  useState,
} from 'react';

import {
  Alert,
  Linking,
  ScrollView,
  Text,
} from 'react-native';

import {
  User,
} from 'firebase/auth';

import {
  logout,
} from '../api/auth';

import {
  deleteAccount,
  getDeleteAccountErrorMessage,
} from '../api/account';

import {
  updateUserDisplayName,
} from '../firebase/users';

import {
  FieldLabel,
  LinkButton,
  PrimaryButton,
  Screen,
  SecondaryButton,
  Subtitle,
  TextField,
  Title,
} from '../components/ui';

import {
  getLegalUrls,
} from '../lib/legalUrls';

import {
  AppRole,
  Team,
  TeamMember,
} from '../types/models';

import {
  isSuperAdminRole,
} from '../lib/roles';

import {
  colors,
  type,
} from '../theme/theme';

type Props = {
  user: User;
  team: Team | null;
  membership: TeamMember | null;
  appRole?: AppRole;
};

async function openUrl(url: string): Promise<void> {
  const canOpen = await Linking.canOpenURL(url);
  if (!canOpen) {
    Alert.alert('Could not open link', url);
    return;
  }
  await Linking.openURL(url);
}

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
  const [deleting, setDeleting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const isSuperAdmin = isSuperAdminRole(appRole);
  const legal = getLegalUrls();

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
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
    } catch (err) {
      Alert.alert(
        'Logout failed',
        err instanceof Error ? err.message : 'Please try again',
      );
    } finally {
      setSigningOut(false);
    }
  }

  function onDeleteAccount() {
    Alert.alert(
      'Delete account?',
      'Your access ends immediately. Cleanup may continue after sign-out. Child profiles, other guardians, teams and events remain. If you are the last organization admin, support must restore administrative control. Calendar entries and emails already copied elsewhere remain. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              await deleteAccount();
            } catch (err) {
              Alert.alert(
                'Delete failed',
                getDeleteAccountErrorMessage(err),
              );
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
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
          disabled={deleting || signingOut}
        />

        <SecondaryButton
          label="Sign out"
          onPress={onLogout}
          loading={signingOut}
          disabled={loading || deleting}
        />

        {(legal.privacy || legal.terms || legal.support) ? (
          <>
            <Text
              style={{
                ...type.label,
                color: colors.text,
                marginTop: 24,
                marginBottom: 4,
              }}
            >
              Legal & support
            </Text>
            {legal.privacy ? (
              <LinkButton
                label="Privacy Policy"
                onPress={() => {
                  void openUrl(legal.privacy!);
                }}
              />
            ) : null}
            {legal.terms ? (
              <LinkButton
                label="Terms of Service"
                onPress={() => {
                  void openUrl(legal.terms!);
                }}
              />
            ) : null}
            {legal.support ? (
              <LinkButton
                label="Support"
                onPress={() => {
                  void openUrl(legal.support!);
                }}
              />
            ) : null}
          </>
        ) : null}

        <SecondaryButton
          label="Delete account"
          onPress={onDeleteAccount}
          loading={deleting}
          disabled={loading || signingOut}
        />
      </ScrollView>
    </Screen>
  );
}
