#!/usr/bin/env node
// Writes the complete council.ts with all features.
// Run: node scripts/write-council-final.js

const fs = require('fs');
const path = 'C:/Users/jaira/Desktop/pando/packages/node/src/platform/council.ts';

const content = `/**
 * Council \u2014 Network Council Selection + Reflection Engine + Chat + Builder Pipeline.
 *
 * Phase 50:  Council selection, rotation, reflection infrastructure.
 * Phase 101b: AI-powered reflection via AIBackendRegistry.
 * Phase 101c: Chat interface (handleMessage) with AI + action detection.
 * Phase 102a: Builder spawning via HTTP POST to /v1/agents/spawn.
 * Phase 102b: Builder completion watcher (bridge queue polling).
 * Phase 102.5: Identity integration (RequestActor).
 * Phase 103c: Full builder \u2192 QA \u2192 governance \u2192 upgrade pipeline.
 * Phase 103e: Real QA tester agent \u2014 independent verification, no hardcoded HTTP pings.
 *
 * State persisted in {dataDir}/council/:
 *   - council-state.json   \u2014 members, rotation, reflection timestamps, active tasks
 *   - council-minutes.md   \u2014 rolling log of council decisions (last 30 entries)
 *   - last-prompt.md       \u2014 most recent assembled reflection prompt
 *   - network-state.md     \u2014 written by NetworkState (read-only here)
 *   - chat-history.json    \u2014 council chat history (max 200 entries)
 *   - request-log.json     \u2014 audit log of council requests
 *   - directives.json      \u2014 founder directives
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { RequestActor } from '@pando/shared';

// \u2500\u2500 Interfaces \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface CouncilMember {
  peerId: string;
  reputation: number;
  hasClaudeCode: boolean;
  uptimeHours: number;
}

export interface CouncilState {
  members: CouncilMember[];
  selectedAt: number;
  rotatesAt: number;
  thisNodeOnCouncil: boolean;
}

export interface ReflectionResult {
  timestamp: number;
  type: 'daily' | 'weekly' | 'monthly';
  summary: string;
  proposals: string[];
  minutesEntry: string;
}

export interface CouncilChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  senderId?: string;
  actorType?: string;
}

export interface ActiveTask {
  taskId: string;
  description: string;
  stage: 'builder' | 'qa' | 'governance' | 'done' | 'failed';
  builderAgentId: string | null;
  qaAgentId: string | null;
  retryCount: number;
  maxRetries: number;
  startedAt: number;
  builderSummary?: string;
  qaVerdict?: string;
}

interface PersistedCouncilState {
  members: CouncilMember[];
  selectedAt: number;
  rotatesAt: number;
  lastDailyReflection: number;
  lastWeeklyReflection: number;
  lastMonthlyReflection: number;
  councilAgentId?: string;
  activeTasks?: ActiveTask[];
}

interface RequestLogEntry {
  timestamp: number;
  actor: { type: string; id: string; label: string };
  action: string;
  summary: string;
  outcome: string;
}

interface FounderDirective {
  id: string;
  content: string;
  addedAt: number;
  addedBy: string;
}

// \u2500\u2500 Constants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const COUNCIL_SIZE = 3;
const ROTATION_MS = 7 * 24 * 60 * 60 * 1000;
const DAILY_MS = 24 * 60 * 60 * 1000;
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const MONTHLY_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MINUTES_ENTRIES = 30;
const MAX_CHAT_HISTORY = 200;
const MAX_REQUEST_LOG = 200;
const BRIDGE_POLL_MS = 10_000;
const MAX_TASK_RETRIES = 3;

const REFLECTION_INTERVALS: Record<string, number> = {
  dev: 60 * 60 * 1000, beta: 4 * 60 * 60 * 1000, live: 24 * 60 * 60 * 1000,
};

function getReflectionInterval(): number {
  const mode = process.env.PANDO_MODE || 'dev';
  return REFLECTION_INTERVALS[mode] || REFLECTION_INTERVALS.dev;
}
`;

fs.writeFileSync(path, content, 'utf-8');
console.log('Written Phase 1 (header + interfaces + constants). Lines:', content.split('\n').length);
