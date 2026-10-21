import React from "react";
import ReactDOM from "react-dom/client";
import { AppRoot } from "@dynatrace/strato-components/core";
import { App } from "./app/App";
import { Boundary } from "./app/components/Boundary";

/* THE PLATFORM'S BLACK, NOT THE LEGACY NAVY.
 *
 * Strato ships two dark themes. Without this flag AppRoot serves the old one,
 * whose base is #19192c — a blue-violet that reads as "some other product"
 * beside a native Dynatrace app. Measured in the shell: the body painted
 * rgb(25, 25, 44) while the apps next to it were neutral black. The flag has
 * to be set BEFORE AppRoot renders, because the theme is resolved once. */
globalThis.dtVisualRefreshEnabled = true;

const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(
  // A render error above the per-view boundaries would otherwise blank the
  // screen and print only "add an error boundary" — this one shows what broke.
  <AppRoot>
    <Boundary label="DeliveryChain UX">
      <App />
    </Boundary>
  </AppRoot>,
);
