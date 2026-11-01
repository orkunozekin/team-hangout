import { agendaTime } from './agendaTime';

export type EventCardInput = {
  title: string;
  type: 'practice' | 'match';
  status?: 'scheduled' | 'postponed' | 'cancelled' | 'completed';
  startsAt?: string;
  endsAt?: string;
  timeZone?: string;
  /** Fallback for legacy events without canonical instants. */
  legacyWhen?: string;
  teamNames?: string[];
  location?: { name: string; address?: string } | null;
  participants?: string[];
  /** Org and season labels; shown only when the viewer spans several. */
  contexts?: string[];
};

export type EventCardContent = {
  title: string;
  typeLabel: 'Match' | 'Practice';
  statusLabel: string | null;
  when: string;
  eventLocalWhen: string | null;
  teams: string | null;
  location: string | null;
  participants: string | null;
  context: string | null;
};

const statusLabels: Record<string, string> = {
  postponed: 'Postponed: awaiting a new schedule',
  cancelled: 'Cancelled',
  completed: 'Completed',
};

const offsetLabel = (instant: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(instant))
    .find(part => part.type === 'timeZoneName')?.value;

/**
 * Card lines follow the owner rules: the schedule revision stays internal, the
 * zone appears once (as the abbreviation inside the time), team names are
 * omitted when the title already names them, and org/season context only
 * appears when it disambiguates.
 */
export function eventCardContent(event: EventCardInput, displayZone?: string): EventCardContent {
  const canonical = event.startsAt && event.endsAt && event.timeZone;
  const zone = displayZone ?? event.timeZone;
  const when = canonical && zone
    ? agendaTime(event.startsAt!, event.endsAt!, zone)
    : event.legacyWhen ?? '';
  const crossZone = !!canonical && !!displayZone && displayZone !== event.timeZone
    && offsetLabel(event.startsAt!, displayZone) !== offsetLabel(event.startsAt!, event.timeZone!);
  const title = event.title.toLocaleLowerCase();
  const names = event.teamNames?.filter(Boolean) ?? [];
  const teamsInTitle = names.every(name => title.includes(name.toLocaleLowerCase()));
  const contexts = [...new Set(event.contexts ?? [])];
  return {
    title: event.title,
    typeLabel: event.type === 'match' ? 'Match' : 'Practice',
    statusLabel: (event.status && statusLabels[event.status]) || null,
    when,
    eventLocalWhen: crossZone ? `Local time: ${agendaTime(event.startsAt!, event.endsAt!, event.timeZone!)}` : null,
    teams: names.length && !teamsInTitle ? names.join(event.type === 'match' ? ' vs ' : ' · ') : null,
    location: event.location?.name ? `${event.location.name}${event.location.address ? `\n${event.location.address}` : ''}` : null,
    participants: event.participants?.length ? event.participants.join(' · ') : null,
    context: contexts.length ? contexts.join('\n') : null,
  };
}
