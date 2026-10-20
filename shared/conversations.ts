/** Callable JSON for scoped channels. Staff notes are a separate command family. */

export type ConversationScopeType = "organization" | "division" | "team" | "event";

/** Keep this allowlist aligned with functions/src/communications/tokens.ts. */
export const CONVERSATION_REACTIONS = [
  { code: "yes", emoji: "👍" },
  { code: "heart", emoji: "❤️" },
  { code: "celebrate", emoji: "🎉" },
  { code: "laugh", emoji: "😂" },
  { code: "clap", emoji: "👏" },
  { code: "check", emoji: "✅" },
  { code: "question", emoji: "❓" },
] as const;

export type ConversationReaction = {
  emoji: string;
  count: number;
  mine: boolean;
};

export type ConversationAttachment = {
  id: string;
  fileName: string;
  detectedType: "image/jpeg" | "image/png" | "application/pdf" | string;
  byteLength: number;
};

export type ConversationMessage = {
  id: string;
  sequence: number;
  authorUid: string;
  body: string | null;
  tombstoned: boolean;
  pinned: boolean;
  createdAt: string;
  editedAt?: string | null;
  revision?: number;
  mine?: boolean;
  reactions?: ConversationReaction[];
  attachments?: ConversationAttachment[];
};

export type ConversationSearchPage = {
  items: ConversationMessage[];
  nextCursor: string | null;
  partial: boolean;
};

export type ConversationPage = {
  conversationId: string;
  mode: "youth" | "adult";
  youthPosting: "open" | "closed";
  pinnedIds: string[];
  items: ConversationMessage[];
  nextCursor: string | null;
  attachments: "enabled" | "disabled";
  canPost: boolean;
};

export type StaffNote = {
  id: string;
  body: string;
  authorUid: string;
  createdAt: string;
};

export type ConversationCommands = {
  postConversationMessage: {
    input: {
      requestId: string;
      orgId: string;
      scopeType: ConversationScopeType;
      scopeId: string;
      text: string;
      attachmentIds?: string[];
    };
    output: { id: string; sequence: number };
  };
  listConversationMessages: {
    input: {
      orgId: string;
      scopeType: ConversationScopeType;
      scopeId: string;
      pageSize?: number;
      cursor?: string | null;
    };
    output: ConversationPage;
  };
  setConversationPin: {
    input: {
      requestId: string;
      orgId: string;
      scopeType: ConversationScopeType;
      scopeId: string;
      messageId: string;
      pinned: boolean;
    };
    output: { pinnedIds: string[] };
  };
  moderateConversationMessage: {
    input: {
      requestId: string;
      orgId: string;
      scopeType: ConversationScopeType;
      scopeId: string;
      messageId: string;
      reason: string;
    };
    output: { id: string; tombstoned: true };
  };
  editConversationMessage: {
    input: {
      requestId: string;
      orgId: string;
      scopeType: ConversationScopeType;
      scopeId: string;
      messageId: string;
      text: string;
      expectedRevision: number;
    };
    output: { id: string; revision: number; editedAt: string };
  };
  reactToConversationMessage: {
    input: {
      requestId: string;
      orgId: string;
      scopeType: ConversationScopeType;
      scopeId: string;
      messageId: string;
      emoji: string;
      expectedRevision: number;
    };
    output: { messageId: string; emoji: string; active: boolean; count: number };
  };
  searchConversationMessages: {
    input: {
      orgId: string;
      scopeType: ConversationScopeType;
      scopeId: string;
      text: string;
      cursor?: string | null;
      from?: string | null;
      to?: string | null;
    };
    output: ConversationSearchPage;
  };
  postStaffNote: {
    input: {
      requestId: string;
      orgId: string;
      scopeType: ConversationScopeType;
      scopeId: string;
      text: string;
    };
    output: { id: string };
  };
  listStaffNotes: {
    input: {
      orgId: string;
      scopeType: ConversationScopeType;
      scopeId: string;
      pageSize?: number;
      cursor?: string | null;
    };
    output: { items: StaffNote[]; nextCursor: string | null };
  };
};
