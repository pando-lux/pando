#!/usr/bin/env python3
"""Apply REQUIRES_HUMAN_ACTION changes to council.ts"""
import sys

path = r'C:\Users\jaira\Desktop\pando\packages\node\src\platform\council.ts'

with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

lines = content.count('\n')
print(f"File has {lines} lines")

# Helper: backslash + n as literal string (for JS \n escape)
BS_N = chr(92) + 'n'  # = \n in JS source code

changes = 0

# 1. Add pendingHumanAlerts and humanActionPath fields
old1 = '  private pendingHealthAlerts: string[] = [];\n  private councilAgentId: string | null = null;'
new1 = (
    '  private pendingHealthAlerts: string[] = [];\n'
    "  private pendingHumanAlerts: string[] = [];   // alerts requiring founder/human action\n"
    "  private humanActionPath: string = '';\n"
    '  private councilAgentId: string | null = null;'
)
if old1 in content:
    content = content.replace(old1, new1, 1)
    changes += 1
    print("P1: Added pendingHumanAlerts field")
else:
    print("P1 SKIP: pattern not found or already applied")

# 2. Constructor init for humanActionPath
old2 = "    this.networkStatePath = join(this.councilDir, 'network-state.md');\n    this.chatHistoryPath"
new2 = (
    "    this.networkStatePath = join(this.councilDir, 'network-state.md');\n"
    "    this.humanActionPath = join(this.councilDir, 'human-action-needed.md');\n"
    "    this.chatHistoryPath"
)
if old2 in content:
    content = content.replace(old2, new2, 1)
    changes += 1
    print("P2: Added humanActionPath constructor init")
else:
    print("P2 SKIP: pattern not found or already applied")

# 3. Add humanActionAlerts variable in runDailyReflection
# The JS code is: this.pendingHealthAlerts.join('\n') where \n is JS escape
join_n = "this.pendingHealthAlerts.join('" + BS_N + "')"
old3 = (
    "    const healthAlerts = this.pendingHealthAlerts.length > 0\n"
    "      ? " + join_n + "\n"
    "      : '(no pending alerts)';\n"
    "\n"
    "    const now = new Date();"
)
new3 = (
    "    const healthAlerts = this.pendingHealthAlerts.length > 0\n"
    "      ? " + join_n + "\n"
    "      : '(no pending alerts)';\n"
    "    const humanActionAlerts = this.pendingHumanAlerts.length > 0\n"
    "      ? this.pendingHumanAlerts.join('" + BS_N + "')\n"
    "      : null;\n"
    "\n"
    "    const now = new Date();"
)
if old3 in content:
    content = content.replace(old3, new3, 1)
    changes += 1
    print("P3: Added humanActionAlerts variable")
else:
    print("P3 SKIP: pattern not found or already applied")
    # Debug
    idx = content.find("this.pendingHealthAlerts.join(")
    if idx >= 0:
        print(f"  Found join at {idx}:", repr(content[idx:idx+40]))

# 4. Add REQUIRES_HUMAN_ACTION section to prompt
old4 = "## Health Alerts\n${healthAlerts}\n\n## Instructions"
new4 = (
    "## Health Alerts\n"
    "${healthAlerts}\n"
    "${humanActionAlerts ? `" + BS_N + "## REQUIRES_HUMAN_ACTION" + BS_N
    + "The following issues CANNOT be self-healed and require founder intervention:" + BS_N
    + "${humanActionAlerts}" + BS_N + "` : ''}\n"
    "## Instructions"
)
if old4 in content:
    content = content.replace(old4, new4, 1)
    changes += 1
    print("P4: Added REQUIRES_HUMAN_ACTION to prompt")
else:
    print("P4 SKIP: pattern not found or already applied")

# 5. Clear pendingHumanAlerts after successful reflection
old5 = "          // Clear health alerts after processing\n          this.pendingHealthAlerts = [];"
new5 = (
    "          // Clear health alerts after processing\n"
    "          this.pendingHealthAlerts = [];\n"
    "          this.pendingHumanAlerts = [];"
)
if old5 in content:
    content = content.replace(old5, new5, 1)
    changes += 1
    print("P5: Added pendingHumanAlerts clear")
else:
    print("P5 SKIP: pattern not found or already applied")

# 6. Upgrade handleHealthAlert signature + add classify/write methods
old6 = (
    "  handleHealthAlert(alert: string): void {\n"
    "    this.pendingHealthAlerts.push(`[${new Date().toISOString()}] ${alert}`);\n"
    "    // Keep max 50 pending alerts\n"
    "    if (this.pendingHealthAlerts.length > 50) {\n"
    "      this.pendingHealthAlerts = this.pendingHealthAlerts.slice(-50);\n"
    "    }\n"
    "  }"
)
new6 = """  handleHealthAlert(alert: string | { severity?: string; type?: string; message?: string; firstSeen?: number }): void {
    const ts = new Date().toISOString();
    const alertStr = typeof alert === 'string'
      ? alert
      : `[${alert.severity || 'medium'}] ${alert.message || alert.type || 'unknown'}`;

    this.pendingHealthAlerts.push(`[${ts}] ${alertStr}`);
    if (this.pendingHealthAlerts.length > 50) {
      this.pendingHealthAlerts = this.pendingHealthAlerts.slice(-50);
    }

    // Classify whether this requires human action (cannot be self-healed)
    if (this.classifyRequiresHuman(alert)) {
      this.pendingHumanAlerts.push(`[${ts}] ${alertStr}`);
      if (this.pendingHumanAlerts.length > 50) {
        this.pendingHumanAlerts = this.pendingHumanAlerts.slice(-50);
      }
      this.writeHumanActionFile();
    }
  }

  /**
   * Classify whether an alert requires human/founder action.
   * Returns true for issues that cannot be self-healed by the network.
   */
  private classifyRequiresHuman(alert: string | { severity?: string; type?: string; message?: string; firstSeen?: number }): boolean {
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    const ONE_DAY = 24 * ONE_HOUR;

    if (typeof alert === 'string') {
      const lower = alert.toLowerCase();
      if (lower.includes('credential') || lower.includes('auth') || lower.includes('invalid') || lower.includes('unauthorized')) {
        return true;
      }
      return false;
    }

    const { severity, type, message, firstSeen } = alert;
    const lower = (message || type || '').toLowerCase();

    // No peers for more than 1 hour — network isolation, needs human intervention
    if (type === 'no_peers' && firstSeen && (now - firstSeen) > ONE_HOUR) {
      return true;
    }

    // Credential/auth errors always need human action
    if (lower.includes('credential') || lower.includes('auth') || lower.includes('invalid') || lower.includes('unauthorized')) {
      return true;
    }

    // Critical alerts persisting for more than 24 hours
    if (severity === 'critical' && firstSeen && (now - firstSeen) > ONE_DAY) {
      return true;
    }

    return false;
  }

  /**
   * Write human-action-needed.md with current pending human alerts.
   * This file signals to the founder that manual intervention is required.
   */
  private writeHumanActionFile(): void {
    try {
      if (this.pendingHumanAlerts.length === 0) return;
      const lines = [
        '# REQUIRES_HUMAN_ACTION',
        '',
        'The following infrastructure issues cannot be self-healed and require founder intervention:',
        '',
        ...this.pendingHumanAlerts.map(a => `- ${a}`),
        '',
        `Last updated: ${new Date().toISOString()}`,
        '',
      ];
      writeFileSync(this.humanActionPath, lines.join('\\\\n'), 'utf-8');
      console.log(`[council] REQUIRES_HUMAN_ACTION: ${this.pendingHumanAlerts.length} issue(s) written to ${this.humanActionPath}`);
    } catch (err: any) {
      console.error(`[council] Failed to write human-action file: ${err.message}`);
    }
  }"""

if old6 in content:
    content = content.replace(old6, new6, 1)
    changes += 1
    print("P6: Upgraded handleHealthAlert + added classify/write methods")
else:
    print("P6 SKIP: pattern not found or already applied")

with open(path, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"\nDone. Applied {changes}/6 changes.")
print(f"New line count: {content.count(chr(10))}")
print("pendingHumanAlerts:", 'pendingHumanAlerts' in content)
print("classifyRequiresHuman:", 'classifyRequiresHuman' in content)
print("writeHumanActionFile:", 'writeHumanActionFile' in content)
print("REQUIRES_HUMAN_ACTION:", 'REQUIRES_HUMAN_ACTION' in content)
