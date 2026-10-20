import type { AgendaEvent, AgendaTeam } from "../../shared/agenda";
import type { ConversationScopeType } from "../../shared/conversations";

export type ConversationTarget = {
  orgId: string;
  scopeType: ConversationScopeType;
  scopeId: string;
  label: string;
};

export type ConversationRoute = Pick<ConversationTarget, "orgId" | "scopeType" | "scopeId">;

export function householdConversationTargets(
  teams: AgendaTeam[],
  events: Pick<AgendaEvent, "id" | "orgId" | "title">[],
): ConversationTarget[] {
  const targets: ConversationTarget[] = [];
  const seen = new Set<string>();
  const add = (target: ConversationTarget) => {
    const key = `${target.scopeType}:${target.orgId}:${target.scopeId}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };
  for (const team of teams) {
    if (team.participants.length) {
      add({
        orgId: team.orgId,
        scopeType: "organization",
        scopeId: team.orgId,
        label: `Open ${team.organizationName} announcements`,
      });
      if (team.divisionId) {
        add({
          orgId: team.orgId,
          scopeType: "division",
          scopeId: team.divisionId,
          label: team.divisionName ? `Open ${team.divisionName} announcements` : "Open division announcements",
        });
      }
    }
    add({
      orgId: team.orgId,
      scopeType: "team",
      scopeId: team.id,
      label: `Open ${team.name} conversation`,
    });
  }
  for (const event of events) {
    add({
      orgId: event.orgId,
      scopeType: "event",
      scopeId: event.id,
      label: `Open conversation for ${event.title}`,
    });
  }
  return targets;
}

export function teamConversationTargets(team: {
  id: string;
  name: string;
  schemaVersion?: number;
  orgId?: string;
}): ConversationTarget[] {
  if (team.schemaVersion !== 2 || !team.orgId) return [];
  return [{
    orgId: team.orgId,
    scopeType: "team",
    scopeId: team.id,
    label: "Open team conversation",
  }];
}

export function eventConversationTarget(event: {
  id: string;
  schemaVersion?: number;
  orgId?: string;
}): ConversationTarget | null {
  if (event.schemaVersion !== 2 || !event.orgId) return null;
  return {
    orgId: event.orgId,
    scopeType: "event",
    scopeId: event.id,
    label: "Open event conversation",
  };
}
