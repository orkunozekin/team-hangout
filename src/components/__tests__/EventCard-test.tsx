import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import EventCard from '../EventCard';

const event = {
  title: 'Maple Foxes vs River Otters',
  type: 'match' as const,
  status: 'scheduled' as const,
  startsAt: '2026-10-03T23:00:00.000Z',
  endsAt: '2026-10-04T00:30:00.000Z',
  timeZone: 'America/Chicago',
  teamNames: ['Maple Foxes', 'River Otters'],
  location: { name: 'North Field' },
};

test('renders the cleaned card and forwards presses', async () => {
  const onPress = jest.fn();
  await render(<EventCard event={event} onPress={onPress} />);
  expect(screen.getByText('Match')).toBeTruthy();
  expect(screen.getByText('Saturday, Oct 3 · 6:00 PM CDT – 7:30 PM CDT')).toBeTruthy();
  expect(screen.getByText('North Field')).toBeTruthy();
  expect(screen.queryByText(/version|America\/Chicago|Maple Foxes vs River Otters\n/i)).toBeNull();
  expect(screen.getAllByText(/Maple Foxes/)).toHaveLength(1);
  await fireEvent.press(screen.getByRole('button'));
  expect(onPress).toHaveBeenCalled();
});
