import { formatCalendarDate } from "../../shared/dates";
import {
  EventType,
} from '../types/models';

export interface EventFormFields {
  title: string;
  type: string;
  date: string;
  time: string;
  locationName?: string;
  locationAddress?: string;
  notes?: string;
}

export interface EventFormErrors {
  title?: string;
  type?: string;
  date?: string;
  time?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

export function isValidEventType(value: string): value is EventType {
  return value === 'practice' || value === 'match';
}

export function validateEventForm(
  fields: EventFormFields,
): EventFormErrors {
  const errors: EventFormErrors = {};

  const title = fields.title.trim();
  if (!title) {
    errors.title = 'Title is required';
  }

  if (!isValidEventType(fields.type)) {
    errors.type = 'Type must be practice or match';
  }

  if (!DATE_RE.test(fields.date.trim())) {
    errors.date = 'Date must be YYYY-MM-DD';
  } else {
    const parsed = new Date(`${fields.date.trim()}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      errors.date = 'Enter a valid date';
    }
  }

  if (!TIME_RE.test(fields.time.trim())) {
    errors.time = 'Time must be HH:mm';
  } else {
    const [hh, mm] = fields.time.trim().split(':').map(Number);
    if (hh > 23 || mm > 59) {
      errors.time = 'Enter a valid time';
    }
  }

  return errors;
}

export function hasEventErrors(errors: EventFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function parseEventDate(dateStr: string): Date {
  return new Date(`${dateStr.trim()}T00:00:00.000Z`);
}

export function formatEventDateLabel(date: Date): string {
  return formatCalendarDate(date);
}

export function validateTeamName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Team name is required';
  if (trimmed.length < 2) return 'Team name must be at least 2 characters';
  if (trimmed.length > 60) return 'Team name must be 60 characters or fewer';
  return null;
}
