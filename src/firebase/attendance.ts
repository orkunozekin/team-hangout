import { httpsCallable } from "firebase/functions";
import { collection, doc } from "firebase/firestore";
import { db, functions } from "./config";
import { runCommand } from "./commands";
import type {
  EventAttendance,
  AttendanceHistory,
} from "../../shared/attendance";
export const attendanceRequestId = () =>
  doc(collection(db, "commandRequests")).id;
export async function getEventAttendance(
  eventId: string,
  teamId: string,
  cursor: string | null = null,
): Promise<EventAttendance> {
  return (
    await httpsCallable<Record<string, unknown>, EventAttendance>(
      functions,
      "getEventAttendance",
    )({ eventId, teamId, cursor })
  ).data;
}
export const recordEventAttendance = (
  payload: Record<string, unknown>,
  requestId: string,
) => runCommand("recordEventAttendance", payload, requestId);
export async function getAttendanceHistory(
  eventId: string,
  teamId: string,
  participantId: string,
  cursor: string | null = null,
): Promise<AttendanceHistory> {
  return (
    await httpsCallable<Record<string, unknown>, AttendanceHistory>(
      functions,
      "getAttendanceHistory",
    )({ eventId, teamId, participantId, cursor })
  ).data;
}
