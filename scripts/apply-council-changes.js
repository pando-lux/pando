#!/usr/bin/env node
// Applies ActiveTask + QA pipeline changes to council.ts
// Uses the .bak file (1078-line version) as the base
const fs = require('fs');

const bakPath = 'C:/Users/jaira/Desktop/pando/packages/node/src/platform/council.ts.bak';
const targetPath = 'C:/Users/jaira/Desktop/pando/packages/node/src/platform/council.ts';

let c = fs.readFileSync(bakPath, 'utf-8');

// Verify base
if (!c.includes('handleBridgeItem') || !c.includes('regressionSuite.runAll')) {
  console.error('ERROR: .bak file is not the expected 1078-line version');
  process.exit(1);
}

// 1. Update header
c = c.replace(
  'Phase 103c: Full builder',
  'Phase 103c: Full builder'
).replace(
  ' * Phase 103c: Full builder \u2192 QA \u2192 governance \u2192 upgrade pipeline.\n *\n * State persisted',
  ' * Phase 103c: Full builder \u2192 QA \u2192 governance \u2192 upgrade pipeline.\n * Phase 103e: Real QA tester agent \u2014 independent verification, no hardcoded HTTP pings.\n *\n * State persisted'
).replace(
  'council-state.json   \u2014 members, rotation, reflection timestamps\n',
  'council-state.json   \u2014 members, rotation, reflection timestamps, active tasks\n'
);

// 2. Add ActiveTask interface
c = c.replace(
  '\ninterface PersistedCouncilState {\n',
  '\nexport interface ActiveTask {\n  taskId: string;\n  description: string;\n  stage: \'builder\' | \'qa\' | \'governance\' | \'done\' | \'failed\';\n  builderAgentId: string | null;\n  qaAgentId: string | null;\n  retryCount: number;\n  maxRetries: number;\n  startedAt: number;\n  builderSummary?: string;\n  qaVerdict?: string;\n}\n\ninterface PersistedCouncilState {\n'
);

// 3. Add activeTasks to PersistedCouncilState
c = c.replace(
  '  councilAgentId?: string;\n}\n\ninterface RequestLogEntry',
  '  councilAgentId?: string;\n  activeTasks?: ActiveTask[];\n}\n\ninterface RequestLogEntry'
);

// 4. Add MAX_TASK_RETRIES
c = c.replace(
  'const BRIDGE_POLL_MS = 10_000;                       // 10s bridge queue poll\n\n// Mode',
  'const BRIDGE_POLL_MS = 10_000;                       // 10s bridge queue poll\nconst MAX_TASK_RETRIES = 3;\n\n// Mode'
);

// 5. Add activeTasks field
c = c.replace(
  '  private councilAgentId: string | null = null;\n\n  constructor',
  '  private councilAgentId: string | null = null;\n  private activeTasks: ActiveTask[] = [];\n\n  constructor'
);

// 6. Add activeTasks loading
c = c.replace(
  '    this.councilAgentId = this.state.councilAgentId || null;\n  }',
  '    this.councilAgentId = this.state.councilAgentId || null;\n    this.activeTasks = this.state.activeTasks || [];\n  }'
);

// 7. Add spawnQAAgent + getActiveTasks before runSelfHealingLoop
const spawnQA = `  /**
   * Spawn a QA tester agent to independently verify a builder's work.
   */
  async spawnQAAgent(taskDescription: string, builderSummary: string): Promise<string | null> {
    const apiPort = this.node.getApiPort?.() || 4000;
    const apiToken = this.loadApiToken();
    if (!apiToken) { console.warn('[council] No API token \\u2014 cannot spawn QA agent'); return null; }

    const taskContext = \`You are an independent QA tester. A builder claims to have completed the following task:\\n\\nTASK: \\\${taskDescription}\\n\\nThe builder reports: "\\\${builderSummary}"\\n\\nDo NOT assume the fix is correct. Test from scratch. Do NOT trust the builder's claims.\\nVerify the changes work by:\\n1. Reading the changed code\\n2. Running the build (npm run build)\\n3. Running relevant tests\\n4. Checking for regressions\\n\\nReport your verdict as the FIRST LINE of your summary:\\n- "PASS: [reason]" if the changes work correctly\\n- "FAIL: [specific issues found]" if there are problems\\n\\nBe specific about what you tested and what you found.\\\`;

    const body: Record<string, any> = {
      role: 'tester', projectId: 'council-fix',
      description: \\\`[Council QA] Verify: \\\${taskDescription.slice(0, 100)}\\\`,
      parentId: this.councilAgentId || null, taskContext,
    };

    try {
      const res = await fetch(\\\`http://127.0.0.1:\\\${apiPort}/v1/agents/spawn\\\`, {
        method: 'POST',
        headers: { 'Authorization': \\\`Bearer \\\${apiToken}\\\`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        console.log(\\\`[council] Spawned QA tester agent: \\\${data.agentId}\\\`);
        this.appendMinutes(\\\`## QA Tester Spawned \\u2014 \\\${new Date().toISOString().slice(0, 10)}\\\\n- Agent: \\\${data.agentId}\\\\n- Verifying: \\\${taskDescription.slice(0, 100)}\\\\n\\\`);
        return data.agentId;
      } else {
        console.error(\\\`[council] Failed to spawn QA agent: \\\${res.status} \\\${await res.text()}\\\`);
        return null;
      }
    } catch (err: any) { console.error(\\\`[council] QA agent spawn error: \\\${err.message}\\\`); return null; }
  }

  getActiveTasks(): ActiveTask[] { return [...this.activeTasks]; }

`;

c = c.replace(
  '  /**\n   * Fire-and-forget: spawn a builder and log to minutes.\n   */',
  spawnQA + '  /**\n   * Fire-and-forget: spawn a builder, track as ActiveTask, log to minutes.\n   */'
);

console.log('Replacements applied. Has spawnQAAgent:', c.includes('spawnQAAgent'));
console.log('Has ActiveTask:', c.includes('ActiveTask'));

// Write atomically
fs.writeFileSync(targetPath, c, 'utf-8');
console.log('Written. Lines:', c.split('\n').length);
