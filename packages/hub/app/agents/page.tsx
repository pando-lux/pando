"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";

/* -- Types ------------------------------------------------- */

interface AgentTreeNode {
  id: string;
  role: string;
  status: string;
  description: string;
  taskCount: number;
  totalCost: number;
  lastActive: number;
  children: AgentTreeNode[];
}

interface AgentState {
  id: string;
  role: string;
  template: string;
  parentId: string | null;
  projectId: string;
  nodeId: string;
  description: string;
  sessionId: string | null;
  status: string;
  createdAt: number;
  lastActive: number;
  taskCount: number;
  totalCost: number;
  children: string[];
  depth: number;
}

/* -- Helpers ------------------------------------------------ */

function relTime(ts: number): string {
  if (!ts) return "--";
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function roleCls(role: string): string {
  const r = role.toLowerCase();
  if (r === "manager") return "bg-purple-500/20 text-purple-600 dark:text-purple-400 border-purple-500/30";
  if (r === "builder") return "bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30";
  if (r === "tester") return "bg-green-500/20 text-green-600 dark:text-green-400 border-green-500/30";
  if (r === "reviewer") return "bg-orange-500/20 text-orange-600 dark:text-orange-400 border-orange-500/30";
  if (r === "researcher") return "bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 border-cyan-500/30";
  if (r === "devops") return "bg-pink-500/20 text-pink-600 dark:text-pink-400 border-pink-500/30";
  return "bg-neutral-500/20 text-neutral-600 dark:text-neutral-400 border-neutral-500/30";
}

function statusCls(s: string): string {
  const st = s.toLowerCase();
  if (st === "active") return "bg-green-500/20 text-green-600 dark:text-green-400";
  if (st === "idle") return "bg-yellow-500/20 text-yellow-600 dark:text-yellow-400";
  if (st === "archived") return "bg-neutral-500/20 text-neutral-600 dark:text-neutral-400";
  if (st === "dead") return "bg-red-500/20 text-red-600 dark:text-red-400";
  return "bg-neutral-500/20 text-neutral-600 dark:text-neutral-400";
}

function statusDotCls(s: string): string {
  const st = s.toLowerCase();
  if (st === "active") return "bg-green-500";
  if (st === "idle") return "bg-yellow-500";
  if (st === "archived") return "bg-neutral-500";
  if (st === "dead") return "bg-red-500";
  return "bg-neutral-500";
}

function shortId(id: string): string {
  if (!id) return "--";
  return id.length > 20 ? id.slice(0, 8) + "\u2026" + id.slice(-4) : id;
}

/* -- TreeNode Component ------------------------------------- */

function TreeNodeRow({
  node,
  depth,
  expandedNodes,
  onToggle,
}: {
  node: AgentTreeNode;
  depth: number;
  expandedNodes: Set<string>;
  onToggle: (id: string) => void;
}) {
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expandedNodes.has(node.id);

  return (
    <>
      <div
        className="flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-100 dark:hover:bg-neutral-800/50 transition cursor-pointer"
        onClick={() => onToggle(node.id)}
      >
        {/* Indentation + tree line */}
        <div className="flex items-center" style={{ paddingLeft: `${depth * 24}px` }}>
          {depth > 0 && (
            <div className="w-4 h-full border-l-2 border-neutral-300 dark:border-neutral-700 mr-2" />
          )}
          {hasChildren ? (
            <span className="text-neutral-500 text-[10px] w-4 text-center flex-shrink-0 select-none">
              {isExpanded ? "\u25BC" : "\u25B6"}
            </span>
          ) : (
            <span className="w-4 flex-shrink-0" />
          )}
        </div>

        {/* Status dot */}
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDotCls(node.status)}`} />

        {/* Role badge */}
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border flex-shrink-0 ${roleCls(node.role)}`}>
          {node.role}
        </span>

        {/* Agent ID */}
        <span className="text-xs font-mono text-neutral-600 dark:text-neutral-400 truncate flex-shrink-0" title={node.id}>
          {shortId(node.id)}
        </span>

        {/* Status badge */}
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${statusCls(node.status)}`}>
          {node.status}
        </span>

        {/* Spacer */}
        <div className="flex-1 min-w-0">
          {node.description && (
            <span className="text-xs text-neutral-500 dark:text-neutral-500 truncate block">
              {node.description}
            </span>
          )}
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 flex-shrink-0 text-xs">
          <span className="text-neutral-500" title="Tasks">
            <span className="font-mono text-neutral-700 dark:text-neutral-300">{node.taskCount}</span> tasks
          </span>
          {node.totalCost > 0 && (
            <span className="text-green-500 font-mono" title="Total cost USD">
              ${node.totalCost < 0.01 ? node.totalCost.toFixed(4) : node.totalCost.toFixed(2)}
            </span>
          )}
          {node.lastActive > 0 && (
            <span className="text-neutral-500 w-16 text-right">{relTime(node.lastActive)}</span>
          )}
        </div>
      </div>

      {/* Detail panel (visible when expanded) */}
      {isExpanded && (
        <div
          className="px-4 py-3 bg-neutral-50 dark:bg-neutral-900/80 border-t border-neutral-200 dark:border-neutral-800 text-xs space-y-1"
          style={{ paddingLeft: `${depth * 24 + 48}px` }}
        >
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-neutral-600 dark:text-neutral-400">
            <span><span className="text-neutral-400 dark:text-neutral-500">ID:</span> <span className="font-mono">{node.id}</span></span>
            {node.description && (
              <span><span className="text-neutral-400 dark:text-neutral-500">Desc:</span> {node.description}</span>
            )}
            <span><span className="text-neutral-400 dark:text-neutral-500">Tasks:</span> {node.taskCount}</span>
            {node.totalCost > 0 && (
              <span><span className="text-neutral-400 dark:text-neutral-500">Cost:</span> <span className="text-green-500 font-mono">${node.totalCost.toFixed(4)}</span></span>
            )}
            {node.lastActive > 0 && (
              <span><span className="text-neutral-400 dark:text-neutral-500">Last active:</span> {relTime(node.lastActive)}</span>
            )}
          </div>
        </div>
      )}

      {/* Children */}
      {hasChildren && isExpanded && (
        <div className="border-l-2 border-neutral-200 dark:border-neutral-800" style={{ marginLeft: `${(depth + 1) * 24 + 16}px` }}>
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expandedNodes={expandedNodes}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </>
  );
}

/* -- Main Page ---------------------------------------------- */

export default function AgentsPage() {
  const [tree, setTree] = useState<AgentTreeNode[]>([]);
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [offline, setOffline] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    try {
      const [treeRes, listRes] = await Promise.all([
        fetch("/api/agents/tree"),
        fetch("/api/agents/list"),
      ]);
      setOffline(false);
      if (treeRes.ok) {
        const d = await treeRes.json();
        setTree(d.tree || d || []);
      }
      if (listRes.ok) {
        const d = await listRes.json();
        setAgents(d.agents || d || []);
      }
      setLoaded(true);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const i = setInterval(fetchData, 10000);
    return () => clearInterval(i);
  }, [fetchData]);

  // Auto-expand all nodes on first load
  useEffect(() => {
    if (loaded && tree.length > 0 && expandedNodes.size === 0) {
      const allIds = new Set<string>();
      function collectIds(nodes: AgentTreeNode[]) {
        for (const n of nodes) {
          if (n.children && n.children.length > 0) {
            allIds.add(n.id);
            collectIds(n.children);
          }
        }
      }
      collectIds(tree);
      setExpandedNodes(allIds);
    }
  }, [loaded, tree, expandedNodes.size]);

  const toggleNode = (id: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Compute summary stats from the flat agent list
  const totalAgents = agents.length;
  const activeCount = agents.filter((a) => a.status.toLowerCase() === "active").length;
  const idleCount = agents.filter((a) => a.status.toLowerCase() === "idle").length;
  const archivedCount = agents.filter((a) => a.status.toLowerCase() === "archived").length;
  const totalCost = agents.reduce((sum, a) => sum + (a.totalCost || 0), 0);

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {/* Page title */}
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">Agent Tree</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            Hierarchical view of all agents managed by this node.
          </p>
        </div>

        {/* Offline banner */}
        {offline && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm text-center">
            Cannot connect to Pando node.
          </div>
        )}

        {/* Summary stats */}
        {loaded && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            {[
              { label: "Total Agents", value: totalAgents },
              {
                label: "Active",
                render: () => (
                  <div className="flex items-center justify-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    <span className="text-lg font-mono font-bold text-green-500 dark:text-green-400">{activeCount}</span>
                  </div>
                ),
              },
              {
                label: "Idle",
                render: () => (
                  <div className="flex items-center justify-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-yellow-500" />
                    <span className="text-lg font-mono font-bold text-yellow-500 dark:text-yellow-400">{idleCount}</span>
                  </div>
                ),
              },
              {
                label: "Archived",
                render: () => (
                  <div className="flex items-center justify-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-neutral-500" />
                    <span className="text-lg font-mono font-bold text-neutral-500 dark:text-neutral-400">{archivedCount}</span>
                  </div>
                ),
              },
              {
                label: "Total Cost",
                render: () => (
                  <p className="text-lg font-mono font-bold text-green-500 dark:text-green-400">
                    ${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}
                  </p>
                ),
              },
            ].map((c, i) => (
              <div
                key={i}
                className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3 text-center"
              >
                <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">{c.label}</p>
                {"render" in c && c.render ? (
                  c.render()
                ) : (
                  <p className="text-lg font-mono font-bold text-neutral-800 dark:text-neutral-200">
                    {(c as { label: string; value: number }).value}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Tree view */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Agent Hierarchy</h2>
            {loaded && (
              <span className="text-[10px] text-neutral-500 font-mono">
                {totalAgents} agent{totalAgents !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          {!loaded ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-neutral-500 animate-pulse">Loading agents...</p>
            </div>
          ) : tree.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">No agents.</p>
              <p className="text-xs text-neutral-500 mt-1">
                Start the scheduler to create the node manager.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {tree.map((node) => (
                <TreeNodeRow
                  key={node.id}
                  node={node}
                  depth={0}
                  expandedNodes={expandedNodes}
                  onToggle={toggleNode}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
