import React from "react";
import ReactDOM from "react-dom/client";
import ChatWidget from "./components/ChatWidget";
import "./index.css";

const root = document.getElementById("chat-root");
if (!root) throw new Error("Chat widget root was not found.");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ChatWidget />
  </React.StrictMode>,
);
