import React from "react";
import ReactDOM from "react-dom/client";
import { AppRoot } from "@dynatrace/strato-components/core";
import { App } from "./app/App";
import { Boundary } from "./app/components/Boundary";

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
