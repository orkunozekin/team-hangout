import type { AdminSection } from "../../shared/admin";
export const sections: AdminSection[] = [
  "import",
  "program",
  "season",
  "division",
  "team",
  "participant",
  "invitation",
  "staff",
  "organization",
];
export const labels: Record<AdminSection, string> = {
  import: "Roster CSV imports",
  invitation: "Invitations",
  participant: "Participants and rosters",
  program: "Programs",
  season: "Seasons",
  division: "Divisions",
  team: "Teams",
  staff: "Staff access",
  organization: "Organization settings",
};
export function readRoute() {
  const match = /^\/organizations\/([A-Za-z0-9_-]+)(?:\/([a-z]+))?\/?$/.exec(
    location.pathname,
  );
  if (!match || (match[2] && !sections.includes(match[2] as AdminSection)))
    return null;
  return {
    orgId: match[1],
    section: (match[2] || "program") as AdminSection,
    programId: new URLSearchParams(location.search).get("program") || "",
  };
}
export function go(path: string) {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
export function routeUrl(orgId: string, section: AdminSection, programId = "") {
  return `/organizations/${encodeURIComponent(orgId)}/${section}${programId ? `?program=${encodeURIComponent(programId)}` : ""}`;
}
