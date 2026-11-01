import React from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import SidebarShell, { sidebarDuration, SIDEBAR_CLOSE_MS, SIDEBAR_OPEN_MS } from '../SidebarShell';

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const context = React.createContext({ top: 40, bottom: 20, left: 0, right: 0 });
  return { SafeAreaInsetsContext: context, useSafeAreaInsets: () => React.useContext(context) };
});

const items = [
  { key: 'Household', label: 'Household', icon: 'home-outline' },
  { key: 'Conversations', label: 'Conversations', icon: 'chatbubbles-outline' },
  { key: 'CalendarSubscriptions', label: 'Calendar subscriptions', icon: 'sync-outline' },
];

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
});
afterEach(() => jest.useRealTimers());

test('reduced motion makes the sidebar open and close instantly', () => {
  expect(sidebarDuration(true, false)).toBe(SIDEBAR_OPEN_MS);
  expect(sidebarDuration(false, false)).toBe(SIDEBAR_CLOSE_MS);
  expect(sidebarDuration(true, true)).toBe(0);
  expect(sidebarDuration(false, true)).toBe(0);
});

test('toggle opens the menu with an accurate label, navigates, and closes from the backdrop', async () => {
  const onSelect = jest.fn();
  await render(
    <SidebarShell items={items} activeKey="Household" title="Household" onSelect={onSelect}>
      <Text>Screen body</Text>
    </SidebarShell>,
  );
  expect(screen.queryByText('Conversations')).toBeNull();
  const toggle = screen.getByTestId('sidebar-toggle');
  expect(toggle.props.accessibilityLabel).toBe('Open navigation menu');
  expect(toggle.props.accessibilityState).toEqual({ expanded: false });

  await fireEvent.press(toggle);
  // While open, the screen behind (toggle included) is hidden from assistive tech; the backdrop closes the menu.
  expect(screen.queryByTestId('sidebar-toggle')).toBeNull();
  expect(screen.getByTestId('sidebar-toggle', { includeHiddenElements: true }).props.accessibilityLabel).toBe('Close navigation menu');
  expect(screen.getByText('Calendar subscriptions')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Household' }).props.accessibilityState).toEqual({ selected: true });

  await fireEvent.press(screen.getByText('Conversations'));
  expect(onSelect).toHaveBeenCalledWith('Conversations');
  await act(async () => { jest.advanceTimersByTime(SIDEBAR_CLOSE_MS + 50); });
  expect(screen.queryByText('Calendar subscriptions')).toBeNull();

  await fireEvent.press(screen.getByTestId('sidebar-toggle'));
  const backdrop = screen.getByTestId('sidebar-backdrop', { includeHiddenElements: true });
  expect(backdrop.props.accessibilityLabel).toBe('Close navigation menu');
  await fireEvent.press(backdrop);
  await act(async () => { jest.advanceTimersByTime(SIDEBAR_CLOSE_MS + 50); });
  expect(screen.queryByText('Calendar subscriptions')).toBeNull();
  expect(onSelect).toHaveBeenCalledTimes(1);
});

test('screens under the sidebar bar do not pad for the top inset twice', async () => {
  const { useSafeAreaInsets } = jest.requireMock('react-native-safe-area-context');
  function Probe() { return <Text>{`top:${useSafeAreaInsets().top}`}</Text>; }
  await render(<SidebarShell items={items} activeKey="Household" title="Household" onSelect={jest.fn()}><Probe /></SidebarShell>);
  expect(screen.getByText('top:0')).toBeTruthy();
});
