import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installClickTracking } from "./track";
import "./styles.css";

installClickTracking();
createRoot(document.getElementById("root")!).render(<App />);
