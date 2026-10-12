import type { Page } from "./admin";
export type InvitationPermissions = {
  viewSchedule: boolean;
  viewProfile: boolean;
  editProfile: boolean;
  respond: boolean;
};
export type Invitation = {
  id: string;
  participantId: string;
  teamId: string | null;
  recipientEmail: string;
  relationship: "guardian" | "self";
  permissions: InvitationPermissions;
  status: string;
  deliveryStatus: string;
  expiresAt: string;
  revision: number;
};
export type InvitationView = {
  status: string;
  participantName?: string;
  relationship?: string;
  permissions?: InvitationPermissions;
};
export type InvitationCommands = {
  createInvitation: {
    input: {
      requestId: string;
      orgId: string;
      participantId: string;
      teamId?: string;
      recipientEmail: string;
      relationship: "guardian" | "self";
      permissions: InvitationPermissions;
    };
    output: { invitation: Invitation };
  };
  resendInvitation: {
    input: {
      requestId: string;
      orgId: string;
      invitationId: string;
      expectedRevision: number;
    };
    output: { invitation: Invitation };
  };
  revokeInvitation: {
    input: {
      requestId: string;
      orgId: string;
      invitationId: string;
      expectedRevision: number;
    };
    output: { status: string };
  };
  listInvitations: {
    input: { orgId: string; cursor?: string; pageSize?: number };
    output: Page<Invitation>;
  };
  inspectInvitation: { input: { token: string }; output: InvitationView };
  acceptInvitation: {
    input: { token: string; confirmed: true };
    output: { status: string };
  };
};
export function invitationMessage(status: string): string {
  const messages: Record<string, string> = {
    "needs-review": "Participant access changed. Ask your organization to review and resend this invitation.",
    used: "This invitation has already been used. Contact your organization for help.",
    accepted: "Invitation accepted. Open your household to check current access.",
    expired:
      "This invitation expired. Ask your organization for a new invitation.",
    revoked: "This invitation was revoked. Contact your organization for help.",
    replaced: "This link was replaced. Open the most recent invitation.",
    "wrong-email":
      "This invitation is for another email address. Sign out, then reopen the invitation and sign in with the intended account.",
    "verify-email":
      "Verify your email address before accepting. Then check the invitation again.",
    unavailable:
      "This invitation is unavailable. Ask your organization for help.",
  };
  return (
    messages[status] ||
    "Unable to check this invitation. Try again or contact your organization."
  );
}
/** Opaque tokens keep their case. URL fragments avoid server/referrer request logging. */
export function invitationTokenFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const path =
      url.protocol === "teamhangout:"
        ? `/${url.hostname}${url.pathname}`
        : url.pathname;
    if (
      !["https:", "http:", "teamhangout:"].includes(url.protocol) ||
      path !== "/invitation"
    )
      return null;
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
    const raw = new URLSearchParams(url.hash.slice(1)).get("token");
    return raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}
