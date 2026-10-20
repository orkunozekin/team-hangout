/** Callable JSON for scoped channels. Staff notes are a separate command family. */

export type ConversationScopeType = "organization" | "division" | "team" | "event";

export type ConversationMessage = {
  id: string;
  sequence: number;
  authorUid: string;
  body: string | null;
  tombstoned: boolean;
  pinned: boolean;
  createdAt: string;
};

export type ConversationPage = {
  conversationId: string;
  mode: "youth" | "adult";
  youthPosting: "open" | "closed";
  pinnedIds: string[];
  items: ConversationMessage[];
  nextCursor: string | null;
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
