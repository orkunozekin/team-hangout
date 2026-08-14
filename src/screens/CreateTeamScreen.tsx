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
  createTeam,
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
  validateTeamName,
} from '../lib/eventForm';

type Props = {
  user: User;
  displayName: string;
  onJoined: () => void;
  onGoToJoin: () => void;
};

export default function CreateTeamScreen({
  user,
  displayName,
  onJoined,
  onGoToJoin,
}: Props) {
  const [name, setName] = useState('');
  const [sport, setSport] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    const nameError = validateTeamName(name);
    setError(nameError ?? undefined);
    if (nameError) return;

    setLoading(true);
    try {
      await createTeam({
        name,
        sport: sport.trim() || null,
        userId: user.uid,
        displayName: displayName || user.email || 'Coach',
      });
      onJoined();
    } catch (err) {
      Alert.alert(
        'Could not create team',
        err instanceof Error ? err.message : 'Please try again',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Screen>
      <ScrollView keyboardShouldPersistTaps="handled">
        <Title>Create your team</Title>
        <Subtitle>
          You will be the coach. Invite players with a shareable code.
        </Subtitle>

        <FieldLabel>Team name</FieldLabel>
        <TextField
          value={name}
          onChangeText={setName}
          error={error}
          placeholder="Friday Night FC"
        />

        <FieldLabel>Sport (optional)</FieldLabel>
        <TextField
          value={sport}
          onChangeText={setSport}
          placeholder="Soccer, basketball, ..."
        />

        <PrimaryButton
          label="Create team"
          onPress={onSubmit}
          loading={loading}
        />

        <LinkButton
          label="Have an invite code? Join a team"
          onPress={onGoToJoin}
        />
      </ScrollView>
    </Screen>
  );
}
