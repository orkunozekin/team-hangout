export function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
}
export function message(error: unknown): string {
  const code = errorCode(error);
  const details =
    typeof error === "object" && error !== null && "details" in error
      ? error.details
      : null;
  const domain =
    details && typeof details === "object" && "domainCode" in details
      ? details.domainCode
      : null;
  if (domain === "SCHEDULE_DRAFT_CHANGED")
    return "This draft changed or was already published. Upload a fresh schedule preview to review current events before committing and publishing again.";
  if (domain === "SCHEDULE_RECIPIENTS_CHANGED")
    return "Notification contacts changed. Review selected publication again before confirming.";
  if (domain === "STALE_REVISION")
    return "This record changed while you were editing. Reload the workspace and review the latest version before saving.";
  if (domain === "ADMIN_WORKSPACE_DISABLED")
    return "The admin workspace is not enabled for this organization. Contact your organization administrator.";
  if (domain === "HIERARCHY_ARCHIVED")
    return "Restore the archived parent organization, program or season before editing.";
  if (code.includes("permission-denied"))
    return "Access unavailable. Your account does not have permission for this organization or program. Contact your administrator.";
  if (code.startsWith("auth/"))
    return code === "auth/too-many-requests"
      ? "Too many attempts. Please try again later."
      : "Unable to sign in. Check your email and password, or reset your password.";
  if (uncertain(error))
    return "The connection was interrupted. Retry this same action to safely confirm its result.";
  if (
    code === "functions/invalid-argument" ||
    code === "functions/failed-precondition"
  )
    return error instanceof Error
      ? error.message
      : "Check the fields and try again.";
  return "Unable to complete this request. Reload and try again, or contact your administrator.";
}
export function uncertain(error: unknown) {
  return [
    "functions/unavailable",
    "functions/deadline-exceeded",
    "functions/internal",
  ].includes(errorCode(error));
}
