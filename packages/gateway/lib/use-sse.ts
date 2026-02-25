"use client";

import { useEffect, useRef, useCallback, useState } from "react";

interface SSECallbacks {
  onStatus?: (status: any) => void;
  onPeers?: (peers: any[]) => void;
  onAgent?: (agent: any) => void;
  onProposalCount?: (count: number) => void;
  onTransaction?: (tx: any) => void;
  onProposal?: (proposal: any) => void;
  onVote?: (vote: any) => void;
  onComment?: (comment: any) => void;
  onDecision?: (decision: any) => void;
  onActivity?: (activity: any) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

/**
 * Hook that connects to the node SSE stream for real-time updates.
 * Falls back to polling if SSE is unavailable.
 */
export function useSSE(callbacks: SSECallbacks) {
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const [sseConnected, setSSEConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    // Clean up any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const es = new EventSource("/api/events");
    eventSourceRef.current = es;

    es.addEventListener("update", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.status) cbRef.current.onStatus?.(data.status);
        if (data.peers) cbRef.current.onPeers?.(data.peers);
        if (data.agent) cbRef.current.onAgent?.(data.agent);
        if (typeof data.proposalCount === "number")
          cbRef.current.onProposalCount?.(data.proposalCount);
      } catch {}
    });

    es.addEventListener("transaction", (e) => {
      try { cbRef.current.onTransaction?.(JSON.parse(e.data)); } catch {}
    });

    es.addEventListener("proposal", (e) => {
      try { cbRef.current.onProposal?.(JSON.parse(e.data)); } catch {}
    });

    es.addEventListener("vote", (e) => {
      try { cbRef.current.onVote?.(JSON.parse(e.data)); } catch {}
    });

    es.addEventListener("comment", (e) => {
      try { cbRef.current.onComment?.(JSON.parse(e.data)); } catch {}
    });

    es.addEventListener("decision", (e) => {
      try { cbRef.current.onDecision?.(JSON.parse(e.data)); } catch {}
    });

    es.addEventListener("activity", (e) => {
      try { cbRef.current.onActivity?.(JSON.parse(e.data)); } catch {}
    });

    // Chat / project progress events — dispatch as custom window events
    // so the chat page (or any listener) can pick them up with thread routing.
    const dispatchChat = (e: Event) => {
      try {
        const msg = JSON.parse((e as MessageEvent).data);
        window.dispatchEvent(new CustomEvent("pando-chat-message", { detail: msg }));
      } catch {}
    };
    es.addEventListener("chat_message", dispatchChat);
    es.addEventListener("manager_output", dispatchChat);
    es.addEventListener("worker_message", dispatchChat);

    // Streaming progress events — partial agent output
    es.addEventListener("chat_progress", (e: Event) => {
      try {
        const msg = JSON.parse((e as MessageEvent).data);
        window.dispatchEvent(new CustomEvent("pando-chat-progress", { detail: msg }));
      } catch {}
    });

    es.onopen = () => {
      setSSEConnected(true);
      cbRef.current.onConnected?.();
    };

    es.onerror = () => {
      setSSEConnected(false);
      cbRef.current.onDisconnected?.();
      es.close();
      eventSourceRef.current = null;
      // Retry after 5 seconds
      retryTimeoutRef.current = setTimeout(connect, 5000);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, [connect]);

  return { sseConnected };
}
