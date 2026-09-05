import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { installViewportGuards } from "./viewportGuards.ts";
import { initVKBridge, installVKViewportSync } from "./game/vkGames.ts";

installViewportGuards();
const removeVKViewportSync = installVKViewportSync();
void initVKBridge();

if (import.meta.hot) import.meta.hot.dispose(removeVKViewportSync);

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
