import React from 'react';
import { Text } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Accordion, DestructiveButton } from '../ui';
import { colors } from '../../theme/theme';

const confirm = { title: 'Delete event?', message: 'This removes the event.', confirmLabel: 'Delete event' };

describe('DestructiveButton', () => {
  it('is red and asks before running the action', async () => {
    const onPress = jest.fn();
    await render(<DestructiveButton label="Delete" confirm={confirm} onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toHaveStyle({ backgroundColor: colors.danger });
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByText('This removes the event.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Delete event' }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('This removes the event.')).toBeNull();
  });

  it('does not run the action when the confirmation is cancelled', async () => {
    const onPress = jest.fn();
    await render(<DestructiveButton label="Delete" confirm={confirm} onPress={onPress} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Keep it' }));
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.queryByText('This removes the event.')).toBeNull();
  });

  it('does not open the confirmation while disabled', async () => {
    const onPress = jest.fn();
    await render(<DestructiveButton label="Delete" disabled confirm={confirm} onPress={onPress} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.queryByText('This removes the event.')).toBeNull();
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('Accordion', () => {
  it('reports expanded state and shows content only when open', async () => {
    const onToggle = jest.fn();
    await render(<Accordion title="Team lineup" onToggle={onToggle}><Text>Lineup body</Text></Accordion>);
    const header = screen.getByRole('button', { name: 'Team lineup' });
    expect(header.props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.queryByText('Lineup body')).toBeNull();
    await fireEvent.press(header);
    expect(screen.getByRole('button', { name: 'Team lineup' }).props.accessibilityState).toMatchObject({ expanded: true });
    expect(screen.getByText('Lineup body')).toBeTruthy();
    expect(onToggle).toHaveBeenLastCalledWith(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Team lineup' }));
    expect(screen.queryByText('Lineup body')).toBeNull();
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });

  it('can start open', async () => {
    await render(<Accordion title="Standings" initiallyOpen><Text>Table</Text></Accordion>);
    expect(screen.getByRole('button', { name: 'Standings' }).props.accessibilityState).toMatchObject({ expanded: true });
    expect(screen.getByText('Table')).toBeTruthy();
  });
});
