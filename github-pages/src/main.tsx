import React from "react";
import ReactDOM from "react-dom/client";
import { VoiceTrail } from "../../app/voice-trail";
import "./style.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <VoiceTrail />
  </React.StrictMode>,
);
