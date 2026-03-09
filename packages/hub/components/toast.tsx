"use client";

import { useState, useEffect, useCallback } from "react";

export interface Toast {
  id: string;
  type: "transfer" | "emission" | "proposal" | "vote" | "comment" | "decision" | "peer" | "info";
  message: string;
  timestamp: number;
}

type Listener = (toasts: Toast[]) => void;

// Module-level toast store — shared across all consumers
let toasts: Toast[] = [];
let listeners: Listener[] = [];
let idCounter = 0;

function notify() {
  listeners.forEach((l) => l([...toasts]));
}

/** Show a toast notification. Auto-dismisses after 5 seconds. */
export function showToast(type: Toast["type"], message: string) {
  const id = `toast-${++idCounter}-${Date.now()}`;
  const toast: Toast = { id, type, message, timestamp: Date.now() };
  toasts = [toast, ...toasts].slice(0, 5); // max 5 visible
  notify();

  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }, 5000);
}

/** Hook to subscribe to toast state. */
function useToasts(): Toast[] {
  const [state, setState] = useState<Toast[]>([]);

  useEffect(() => {
    listeners.push(setState);
    return () => {
      listeners = listeners.filter((l) => l !== setState);
    };
  }, []);

  return state;
}

const ICONS: Record<Toast["type"], string> = {
  transfer: "\u2B06", // ⬆ arrow
  emission: "\u2728", // ✨ sparkles
  proposal: "\uD83D\uDCDD", // 📝
  vote: "\uD83D\uDDF3\uFE0F", // 🗳️
  comment: "\uD83D\uDCAC", // 💬
  decision: "\u2696\uFE0F", // ⚖️
  peer: "\uD83D\uDD17", // 🔗
  info: "\u2139\uFE0F", // ℹ️
};

const COLORS: Record<Toast["type"], string> = {
  transfer: "border-amber-500/40 bg-amber-500/10",
  emission: "border-green-500/40 bg-green-500/10",
  proposal: "border-blue-500/40 bg-blue-500/10",
  vote: "border-purple-500/40 bg-purple-500/10",
  comment: "border-cyan-500/40 bg-cyan-500/10",
  decision: "border-emerald-500/40 bg-emerald-500/10",
  peer: "border-teal-500/40 bg-teal-500/10",
  info: "border-neutral-500/40 bg-neutral-500/10",
};

/** Renders toast notifications. Place once at the top level of your page. */
export function ToastContainer() {
  const items = useToasts();

  if (items.length === 0) return null;

  return (
    <div className="fixed top-16 right-4 z-[60] flex flex-col gap-2 max-w-sm pointer-events-auto">
      {items.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-2 px-4 py-3 rounded-lg border text-sm text-neutral-800 dark:text-neutral-200 shadow-lg backdrop-blur-sm animate-slide-in ${COLORS[t.type]}`}
        >
          <span className="text-base flex-shrink-0">{ICONS[t.type]}</span>
          <span className="leading-snug break-words">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
