import { ConvexProvider, ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
const root = createRoot(document.getElementById("root")!);

if (!url) {
  root.render(
    <main className="page">
      <h1>convex-tinybird demo</h1>
      <p className="notice error">
        <code>VITE_CONVEX_URL</code> is not set. Run <code>pnpm --dir example run dev</code>, which
        starts a local Convex backend and writes <code>.env.local</code> before Vite starts.
      </p>
    </main>,
  );
} else {
  const client = new ConvexReactClient(url);
  root.render(
    <StrictMode>
      <ConvexProvider client={client}>
        <App />
      </ConvexProvider>
    </StrictMode>,
  );
}
