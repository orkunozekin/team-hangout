import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { User } from 'firebase/auth';
import ProfileScreen from '../ProfileScreen';
import { logout } from '../../api/auth';

jest.mock('../../api/auth', () => ({ logout: jest.fn() }));
jest.mock('../../api/account', () => ({ deleteAccount: jest.fn(), getDeleteAccountErrorMessage: jest.fn() }));
jest.mock('../../firebase/users', () => ({ updateUserDisplayName: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));

const user = { uid: 'user-a', email: 'a@example.com', displayName: 'Alex' } as User;

test('shows a busy, non-repeatable Sign out button until logout settles', async () => {
  let finish: () => void = () => undefined;
  (logout as jest.Mock).mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  await render(<ProfileScreen user={user} team={null} membership={null} />);

  await act(async () => { fireEvent.press(screen.getByLabelText('Sign out')); });
  expect(screen.getByLabelText('Sign out').props.accessibilityState).toEqual({ disabled: true, busy: true });
  expect(screen.getByLabelText('Save profile').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByLabelText('Delete account').props.accessibilityState.disabled).toBe(true);

  await act(async () => { fireEvent.press(screen.getByLabelText('Sign out')); });
  expect(logout).toHaveBeenCalledTimes(1);

  await act(async () => finish());
  expect(screen.getByLabelText('Sign out').props.accessibilityState).toEqual({ disabled: false, busy: false });
});
