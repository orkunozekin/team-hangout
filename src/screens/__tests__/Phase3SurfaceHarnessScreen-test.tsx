import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';

import Phase3SurfaceHarnessScreen from '../Phase3SurfaceHarnessScreen';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('react-native-gesture-handler', () => {
  const React = require('react');
  const { View } = require('react-native');
  function Pan() {
    const handlers: Record<string, (event?: unknown) => void> = {};
    const chain = {
      handlers,
      activateAfterLongPress: () => chain,
      minDistance: () => chain,
      runOnJS: () => chain,
      onStart: (callback: () => void) => { handlers.onStart = callback; return chain; },
      onUpdate: (callback: (event?: unknown) => void) => { handlers.onUpdate = callback; return chain; },
      onEnd: (callback: () => void) => { handlers.onEnd = callback; return chain; },
    };
    return chain;
  }
  return {
    Gesture: { Pan },
    GestureDetector: ({ gesture, children }: { gesture: unknown; children: React.ReactNode }) => (
      <View testID="pan-detector" gesture={gesture}>{children}</View>
    ),
    GestureHandlerRootView: View,
  };
});

type PanHandlers = { onStart: () => void; onUpdate: (event: { translationX: number; translationY: number }) => void };

function markerPan(name: RegExp): PanHandlers {
  const detector = screen.getAllByTestId('pan-detector').find((candidate) => within(candidate).queryByLabelText(name));
  if (!detector) throw new Error(`No draggable marker matches ${name}`);
  return detector.props.gesture.handlers;
}

function markerOffset(name: RegExp) {
  const style = StyleSheet.flatten(screen.getByLabelText(name).props.style);
  return { left: style.left as number, top: style.top as number };
}

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
    await fireEvent.press(screen.getByRole('button', { name: 'Place Samira Abdullah-Rahman at Goalkeeper, currently Alexis Montgomery-Washington' }));

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

  test('drags a held marker by cumulative translation from where the drag started', async () => {
    await render(<Phase3SurfaceHarnessScreen />);
    const alexis = /Alexis Montgomery-Washington marker/;
    const start = markerOffset(alexis);

    await act(async () => {
      markerPan(alexis).onStart();
      markerPan(alexis).onUpdate({ translationX: -10, translationY: -20 });
    });
    expect(markerOffset(alexis)).toEqual({ left: start.left - 10, top: start.top - 20 });

    await act(async () => {
      markerPan(alexis).onUpdate({ translationX: -30, translationY: -60 });
    });
    expect(markerOffset(alexis)).toEqual({ left: start.left - 30, top: start.top - 60 });
    expect(screen.getByLabelText(alexis).props.accessibilityState.selected).toBe(true);

    await act(async () => {
      markerPan(alexis).onUpdate({ translationX: -100000, translationY: 100000 });
    });
    const markerRadius = 22;
    const bottomRight = markerOffset(alexis);
    expect(bottomRight.left).toBe(-markerRadius);
    expect(bottomRight.top).toBeGreaterThan(start.top);
  });
});
