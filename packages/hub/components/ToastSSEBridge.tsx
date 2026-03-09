"use client";

import { useRef } from "react";
import { useSSE } from "@/lib/use-sse";
import { showToast, ToastContainer } from "./toast";

/**
 * Global toast + SSE bridge. Place in layout.tsx so all pages get
 * real-time toast notifications for network events.
 *
 * Dispatches toasts for: peer_connect, transfers, proposals, votes,
 * comments, and decisions.
 */
export default function ToastSSEBridge() {
  const peerCountRef = useRef<number | null>(null);

  useSSE({
    onPeers: (peers) => {
      const prev = peerCountRef.current;
      const next = peers.length;
      peerCountRef.current = next;
      // Only toast on increase (new peer connected), not on initial load
      if (prev !== null && next > prev) {
        const diff = next - prev;
        showToast(
          "peer",
          diff === 1
            ? `New peer connected (${next} total)`
            : `${diff} new peers connected (${next} total)`
        );
      }
    },
    onTransaction: (tx) => {
      const short = (id: string) => id?.slice(-6) || "?";
      if (tx.type === "emission") {
        showToast("emission", `${tx.amount} Lux emitted to ${short(tx.to)}`);
      } else {
        showToast(
          "transfer",
          `${tx.amount} Lux: ${short(tx.from)} \u2192 ${short(tx.to)}`
        );
      }
    },
    onProposal: (proposal) => {
      showToast(
        "proposal",
        `New proposal: ${proposal.title?.slice(0, 60) || "Untitled"}`
      );
    },
    onVote: (vote) => {
      showToast(
        "vote",
        `Vote ${vote.choice} on "${vote.proposalTitle?.slice(0, 40) || "proposal"}"`
      );
    },
    onActivity: (activity) => {
      if (activity?.type === 'comment') {
        showToast("comment", `Comment: "${activity.content?.slice(0, 50) || "..."}"`);
      } else if (activity?.type === 'decision') {
        showToast("decision", `Proposal ${activity.outcome}: "${activity.proposalTitle?.slice(0, 40) || "proposal"}"`);
      }
    },
  });

  return <ToastContainer />;
}
