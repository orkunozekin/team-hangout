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
  id: string;
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
