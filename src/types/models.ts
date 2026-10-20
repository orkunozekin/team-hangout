export type TeamRole = 'coach' | 'player';

/** Platform-level role for app owners/devs (not team-scoped). */
export type AppRole = 'user' | 'superAdmin';

export type EventType = 'practice' | 'match';

export type EventTypeFilter = 'all' | EventType;

export interface AppUser {
  uid: string;
  email: string;
  displayName: string;
  appRole: AppRole;
  activeTeamId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Team {
  schemaVersion?: number;
  timeZone?: string;
  orgId?: string;
  divisionId?: string;
  id: string;
  name: string;
  sport: string | null;
  inviteCode: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  role: TeamRole;
  displayName: string;
  joinedAt: Date;
}

export interface InviteCodeLookup {
  code: string;
  teamId: string;
  createdBy: string;
  createdAt: Date;
}

export interface EventLocation {
  name: string;
  address?: string;
}

export interface TeamEvent {
  schemaVersion?: number;
  orgId?: string;
  startsAt?: string;
  endsAt?: string;
  timeZone?: string;
  status?: import('../../shared/operations').EventStatus;
  scheduleVersion?: number;
  teams?: { id: string; name: string }[];
  canManage?: boolean;
  history?: { revision: number; action: string; reason?: string; previousStatus: string; status: string; previousStartsAt: string; startsAt: string; previousTimeZone?: string; timeZone?: string }[];
  historyHasMore?: boolean;
  id: string;
  revision?: number;
  teamId: string;
  type: EventType;
  title: string;
  date: Date;
  time: string;
  location: EventLocation | null;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CreateEventInput {
  teamId: string;
  type: EventType;
  title: string;
  date: Date;
  time: string;
  location?: EventLocation | null;
  notes?: string | null;
  createdBy: string;
}

export interface UpdateEventInput {
  type?: EventType;
  title?: string;
  date?: Date;
  time?: string;
  location?: EventLocation | null;
  notes?: string | null;
}

/** Canonical operations remain distinct from the legacy split date/time UI contract. */
export type { CanonicalTeamEvent } from '../firebase/operationalEvents';
export type { EventStatus, PublicationState, AvailabilityStatus, AttendanceStatus, AttendanceSource, RevisionRequest } from '../../shared/operations';
