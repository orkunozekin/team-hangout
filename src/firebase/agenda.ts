import { httpsCallable } from "firebase/functions";
import type { AgendaPage, AgendaRequest } from "../../shared/agenda";
import { functions } from "./config";
export async function listHouseholdAgenda(
  request: AgendaRequest,
): Promise<AgendaPage> {
  return (
    await httpsCallable<AgendaRequest, AgendaPage>(
      functions,
      "listHouseholdAgenda",
    )(request)
  ).data;
}
