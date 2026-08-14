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
  joinTeamWithInviteCode,
} from '../firebase/teams';

import {
  FieldLabel,
  LinkButton,
  PrimaryButton,
  Screen,
  Subtitle,
  TextField,
  Title,
} from '../components/ui';

import {
  isValidInviteCodeFormat,
  normalizeInviteCode,
} from '../lib/inviteCode';

type Props = {
  user: User;
  displayName: string;
  onJoined: () => void;
  onGoToCreate: () => void;
  initialCode?: string;
};

export default function JoinTeamScreen({
  user,
  displayName,
  onJoined,
  onGoToCreate,
  initialCode = '',
}: Props) {
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    const normalized = normalizeInviteCode(code);
    if (!isValidInviteCodeFormat(normalized)) {
      setError('Enter a valid 8-character invite code');
      return;
    }
    setError(undefined);

    setLoading(true);
    try {
      await joinTeamWithInviteCode({
        code: normalized,
        userId: user.uid,
        displayName: displayName || user.email || 'Player',
      });
      onJoined();
    } catch (err) {
      Alert.alert(
        'Could not join team',
        err instanceof Error ? err.message : 'Please try again',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen>
      <ScrollView keyboardShouldPersistTaps="handled">
        <Title>Join a team</Title>
        <Subtitle>
          Enter the invite code from your coach.
        </Subtitle>

        <FieldLabel>Invite code</FieldLabel>
        <TextField
          autoCapitalize="characters"
          autoCorrect={false}
          value={code}
          onChangeText={setCode}
          error={error}
          placeholder="ABCD2345"
        />

        <PrimaryButton
          label="Join team"
          onPress={onSubmit}
          loading={loading}
        />

        <LinkButton
          label="Create a new team instead"
          onPress={onGoToCreate}
        />
      </ScrollView>
    </Screen>
  );
}
