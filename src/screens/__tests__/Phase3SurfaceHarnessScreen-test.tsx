import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import Phase3SurfaceHarnessScreen from '../Phase3SurfaceHarnessScreen';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('react-native-gesture-handler', () => {
  const React = require('react');
  const { View } = require('react-native');
  const chain = {
    activateAfterLongPress: () => chain,
    minDistance: () => chain,
    runOnJS: () => chain,
    onStart: () => chain,
    onUpdate: () => chain,
    onEnd: () => chain,
  };
  return {
    Gesture: { Pan: () => chain },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    GestureHandlerRootView: View,
  };
});

describe('Phase 3 development surface harness', () => {
  test('renders the three explicit presets and 30 synthetic participants', async () => {
    await render(<Phase3SurfaceHarnessScreen />);

    expect(screen.getByRole('header', { name: 'Lineup surface lab' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Soccer preset' }).props.accessibilityState.selected).toBe(true);
    expect(screen.getByRole('radio', { name: 'Basketball preset' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Football preset' })).toBeTruthy();
    expect(screen.getAllByLabelText(/synthetic roster participant/)).toHaveLength(30);
  });

  test('shows unit capacity and selected marker when presets change', async () => {
    await render(<Phase3SurfaceHarnessScreen />);

    await fireEvent.press(screen.getByRole('radio', { name: 'Basketball preset' }));

    expect(screen.getByText('5 of 5 on court')).toBeTruthy();
    expect(screen.getAllByLabelText(/marker, selected/)).toHaveLength(1);
    expect(screen.getAllByLabelText(/marker,/)).toHaveLength(5);
  });

  test('supports a complete screen-reader-friendly list placement path', async () => {
    await render(<Phase3SurfaceHarnessScreen />);

    await fireEvent.press(screen.getByRole('radio', { name: 'Accessible list mode' }));
    await fireEvent.press(screen.getByLabelText('Samira Abdullah-Rahman, synthetic roster participant 30'));
    await fireEvent.press(screen.getByRole('button', { name: 'Place Samira Abdullah-Rahman at Goalkeeper' }));

    expect(screen.getByText('Samira Abdullah-Rahman is now Goalkeeper.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Samira Abdullah-Rahman at Goalkeeper, selected' })).toBeTruthy();
  });

  test('keeps labels scalable instead of truncating names', async () => {
    await render(<Phase3SurfaceHarnessScreen />);

    const longNames = screen.getAllByText('Alexis Montgomery-Washington');
    expect(longNames.every((longName) => longName.props.allowFontScaling !== false)).toBe(true);
    expect(longNames.every((longName) => longName.props.maxFontSizeMultiplier >= 2)).toBe(true);
    expect(longNames.every((longName) => longName.props.numberOfLines === undefined)).toBe(true);
  });
});
