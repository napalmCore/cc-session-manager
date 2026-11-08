import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./global.css";
import { readPageKey } from "./pageKey.js";

// Takes the key out of the address before anything renders.
readPageKey();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
