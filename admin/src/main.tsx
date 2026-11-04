import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initializeBrowserFirebase } from "./firebase";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
try {
  root.render(<App services={initializeBrowserFirebase()} />);
} catch (error) {
  root.render(
    <main id="main-content" tabIndex={-1} className="auth-card">
      <h1>Workspace setup required</h1>
      <p role="alert">
        {error instanceof Error
          ? error.message
          : "Unable to initialize the workspace."}
      </p>
    </main>,
  );
}
