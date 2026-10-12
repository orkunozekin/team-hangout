import { initializeApp } from "firebase/app";
import {
  browserSessionPersistence,
  connectAuthEmulator,
  initializeAuth,
} from "firebase/auth";
import {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
} from "firebase/functions";
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "firebase/firestore";
import type { User } from "firebase/auth";
import type { AdminCommands } from "../../shared/admin";

export function initializeBrowserFirebase() {
  const env = import.meta.env;
  const config = {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  };
  if (Object.values(config).some((value) => !value))
    throw new Error(
      "Browser Firebase configuration is missing. Follow docs/browser-admin.md.",
    );
  const demo = config.projectId.startsWith("demo-");
  const emulator = env.VITE_USE_EMULATORS === "1";
  if (
    emulator &&
    (!demo || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname))
  ) {
    throw new Error(
      "Emulator mode requires a demo project and a loopback browser host.",
    );
  }
  if (demo && !emulator)
    throw new Error("Demo projects require explicit emulator opt-in.");
  const app = initializeApp(config, "admin-browser");
  const auth = initializeAuth(app, { persistence: browserSessionPersistence });
  const db = getFirestore(app);
  const functions = getFunctions(
    app,
    env.VITE_FIREBASE_FUNCTIONS_REGION || "us-central1",
  );
  if (emulator) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  }
  async function call<K extends keyof AdminCommands>(
    name: K,
    data: AdminCommands[K]["input"],
  ): Promise<AdminCommands[K]["output"]> {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new Error("Sign in to continue.");
    const result = await httpsCallable<
      AdminCommands[K]["input"],
      AdminCommands[K]["output"]
    >(
      functions,
      name,
    )(data);
    if (auth.currentUser?.uid !== uid)
      throw new Error("Your account changed. Reload the workspace.");
    return result.data;
  }
  async function ensureProfile(user: User) {
    const ref = doc(db, "users", user.uid);
    const existing = await getDoc(ref);
    if (!existing.exists())
      await setDoc(ref, {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || "Household member",
        appRole: "user",
        activeTeamId: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
  }
  return { auth, call, emulator, ensureProfile };
}
export type BrowserServices = ReturnType<typeof initializeBrowserFirebase>;
