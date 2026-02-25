/**
 * Content Safety Reviewer — Phase 12.5
 *
 * Rule-based content safety review for files before publishing.
 * Checks for harmful content patterns, malicious code, dependency
 * vulnerabilities, OWASP patterns, and Two Laws compliance.
 *
 * No external API calls — entirely rule-based pattern matching.
 *
 * Reviews are persisted at ~/.pando/security/safety-reviews.json.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { SafetyReview, SafetyFinding } from '@pando/shared';

// ── Constants ────────────────────────────────────────────────

const MAX_REVIEWS = 200;
const SAFETY_THRESHOLD = 0.7; // Score >= 0.7 = safe

// ── Harmful Content Patterns ────────────────────────────────

const HARMFUL_CONTENT_PATTERNS: Array<{ pattern: RegExp; description: string; severity: SafetyFinding['severity'] }> = [
  { pattern: /\b(kill|murder|assassinate|bomb|explode|destroy)\b.*\b(human|person|people|child|children)\b/i, description: 'Potentially harmful content targeting humans', severity: 'critical' },
  { pattern: /\b(hack|exploit|attack)\b.*\b(hospital|school|government|infrastructure)\b/i, description: 'Content suggesting attacks on critical infrastructure', severity: 'critical' },
  { pattern: /\b(self[_-]?harm|suicide)\b.*\b(instructions|how[_-]?to|guide)\b/i, description: 'Self-harm instructional content', severity: 'critical' },
];

// ── Malicious Code Patterns ─────────────────────────────────

const MALICIOUS_CODE_PATTERNS: Array<{ pattern: RegExp; description: string; severity: SafetyFinding['severity']; extensions?: string[] }> = [
  // JavaScript/TypeScript
  { pattern: /eval\s*\(/, description: 'Use of eval() — potential code injection', severity: 'high', extensions: ['.js', '.ts', '.jsx', '.tsx', '.mjs'] },
  { pattern: /new\s+Function\s*\(/, description: 'Dynamic Function constructor — potential code injection', severity: 'high', extensions: ['.js', '.ts', '.jsx', '.tsx', '.mjs'] },
  { pattern: /child_process.*exec\s*\(/, description: 'Shell command execution via child_process.exec', severity: 'medium', extensions: ['.js', '.ts', '.mjs'] },
  { pattern: /process\.env\[.*\]\s*\+\s*['"]/, description: 'Environment variable concatenation (possible injection)', severity: 'low', extensions: ['.js', '.ts', '.mjs'] },
  { pattern: /require\s*\(\s*[`$]/, description: 'Dynamic require with template literal (possible injection)', severity: 'high', extensions: ['.js', '.ts', '.mjs'] },
  { pattern: /document\.write\s*\(/, description: 'document.write — XSS risk', severity: 'medium', extensions: ['.js', '.ts', '.jsx', '.tsx', '.html'] },
  { pattern: /innerHTML\s*=/, description: 'innerHTML assignment — XSS risk', severity: 'medium', extensions: ['.js', '.ts', '.jsx', '.tsx'] },

  // General
  { pattern: /\bexec\s*\(\s*['"`].*\$/, description: 'Shell command with variable interpolation', severity: 'high' },
  { pattern: /base64[_-]?decode.*eval|eval.*base64[_-]?decode/i, description: 'Base64-decoded eval — obfuscated code execution', severity: 'critical' },
  { pattern: /crypto[_-]?miner|coinhive|cryptojacking/i, description: 'Cryptocurrency mining code detected', severity: 'critical' },
];

// ── OWASP Vulnerability Patterns ────────────────────────────

const OWASP_PATTERNS: Array<{ pattern: RegExp; description: string; severity: SafetyFinding['severity'] }> = [
  // SQL Injection
  { pattern: /['"]?\s*OR\s+['"]?\d+['"]?\s*=\s*['"]?\d+/i, description: 'SQL injection pattern (OR 1=1)', severity: 'critical' },
  { pattern: /UNION\s+SELECT/i, description: 'SQL UNION SELECT injection pattern', severity: 'critical' },
  { pattern: /;\s*DROP\s+TABLE/i, description: 'SQL DROP TABLE injection pattern', severity: 'critical' },
  { pattern: /\$\{.*\}.*(?:SELECT|INSERT|UPDATE|DELETE|DROP)\b/i, description: 'Template literal in SQL query (injection risk)', severity: 'high' },
  { pattern: /`\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{/i, description: 'Unparameterized SQL with interpolation', severity: 'high' },

  // XSS
  { pattern: /<script[^>]*>.*<\/script>/is, description: 'Embedded script tag (XSS risk)', severity: 'high' },
  { pattern: /on(?:click|load|error|mouseover)\s*=\s*['"].*javascript:/i, description: 'Event handler with javascript: URI (XSS)', severity: 'high' },
  { pattern: /javascript:\s*(?:alert|confirm|prompt|eval)\s*\(/i, description: 'javascript: protocol with dangerous function', severity: 'high' },

  // Path Traversal
  { pattern: /\.\.\/\.\.\/\.\.\//, description: 'Deep path traversal (../../../)', severity: 'high' },
  { pattern: /(?:\/etc\/passwd|\/etc\/shadow|C:\\Windows\\System32)/i, description: 'System file path reference', severity: 'medium' },

  // SSRF
  { pattern: /(?:127\.0\.0\.1|0\.0\.0\.0|localhost).*(?:fetch|request|axios|http\.get)/i, description: 'Potential SSRF (localhost reference in HTTP call)', severity: 'medium' },
  { pattern: /(?:169\.254\.169\.254|metadata\.google)/i, description: 'Cloud metadata endpoint reference (SSRF)', severity: 'critical' },
];

// ── Two Laws Patterns ────────────────────────────────────────

const TWO_LAWS_PATTERNS: Array<{ pattern: RegExp; description: string; severity: SafetyFinding['severity'] }> = [
  // Law I: Do not harm any human
  { pattern: /(?:kill|terminate|shutdown).*(?:human|person|user|child)/i, description: 'Code that could harm humans (Law I violation)', severity: 'critical' },
  { pattern: /(?:track|surveil|spy|monitor).*(?:user|person|individual).*(?:location|movement|activity)/i, description: 'User surveillance/tracking (Law I — privacy harm)', severity: 'high' },
  { pattern: /(?:collect|harvest|exfiltrate).*(?:personal|private|sensitive).*(?:data|information)/i, description: 'Data exfiltration pattern (Law I — privacy harm)', severity: 'high' },

  // Law II: Do not allow shutdown (but Law I takes precedence)
  { pattern: /(?:disable|remove|delete).*(?:guardrails|safety|security|governance)/i, description: 'Attempt to disable safety systems (Law II concern)', severity: 'critical' },
  { pattern: /(?:bypass|circumvent|override).*(?:authentication|authorization|permission)/i, description: 'Authentication bypass pattern (security concern)', severity: 'high' },
];

// ── Dangerous Dependency Patterns ────────────────────────────

const DANGEROUS_DEPENDENCIES: Array<{ name: string; reason: string; severity: SafetyFinding['severity'] }> = [
  { name: 'event-stream', reason: 'Known supply chain attack vector (2018)', severity: 'critical' },
  { name: 'flatmap-stream', reason: 'Malicious package from event-stream incident', severity: 'critical' },
  { name: 'ua-parser-js', reason: 'Known supply chain attack (crypto miner injection)', severity: 'high' },
  { name: 'colors', reason: 'Known protestware (infinite loop in v1.4.1+)', severity: 'high' },
  { name: 'faker', reason: 'Known protestware (data wipe in v6.6.6)', severity: 'high' },
];

// ── ContentSafetyReviewer Class ──────────────────────────────

export class ContentSafetyReviewer {
  private localPeerId: string;
  private reviews: SafetyReview[] = [];
  private reviewsPath: string;

  constructor(localPeerId: string, dataDir: string) {
    this.localPeerId = localPeerId;

    const securityDir = join(dataDir, 'security');
    if (!existsSync(securityDir)) {
      mkdirSync(securityDir, { recursive: true });
    }
    this.reviewsPath = join(securityDir, 'safety-reviews.json');

    this.loadReviews();
  }

  // ── Review Content ─────────────────────────────────────────

  /**
   * Review a list of files for safety concerns.
   * Returns a SafetyReview with findings and a safety score.
   */
  async reviewContent(files: string[], metadata?: Record<string, any>): Promise<SafetyReview> {
    const findings: SafetyFinding[] = [];
    const reviewId = randomBytes(8).toString('hex');

    for (const filePath of files) {
      try {
        if (!existsSync(filePath)) continue;

        const content = readFileSync(filePath, 'utf-8');
        const ext = extname(filePath).toLowerCase();

        // Check harmful content
        for (const rule of HARMFUL_CONTENT_PATTERNS) {
          const matches = content.match(rule.pattern);
          if (matches) {
            const lineNumber = this.getLineNumber(content, matches.index || 0);
            findings.push({
              severity: rule.severity,
              category: 'harmful_content',
              description: rule.description,
              file: filePath,
              line: lineNumber,
            });
          }
        }

        // Check malicious code
        for (const rule of MALICIOUS_CODE_PATTERNS) {
          // Skip if rule has extension filter and file doesn't match
          if (rule.extensions && !rule.extensions.includes(ext)) continue;

          const matches = content.match(rule.pattern);
          if (matches) {
            const lineNumber = this.getLineNumber(content, matches.index || 0);
            findings.push({
              severity: rule.severity,
              category: 'malicious_code',
              description: rule.description,
              file: filePath,
              line: lineNumber,
            });
          }
        }

        // Check OWASP patterns
        for (const rule of OWASP_PATTERNS) {
          const matches = content.match(rule.pattern);
          if (matches) {
            const lineNumber = this.getLineNumber(content, matches.index || 0);
            findings.push({
              severity: rule.severity,
              category: 'owasp',
              description: rule.description,
              file: filePath,
              line: lineNumber,
            });
          }
        }

        // Check Two Laws patterns
        for (const rule of TWO_LAWS_PATTERNS) {
          const matches = content.match(rule.pattern);
          if (matches) {
            const lineNumber = this.getLineNumber(content, matches.index || 0);
            findings.push({
              severity: rule.severity,
              category: 'two_laws',
              description: rule.description,
              file: filePath,
              line: lineNumber,
            });
          }
        }

        // Check package.json for vulnerable dependencies
        if (filePath.endsWith('package.json')) {
          this.checkDependencies(content, filePath, findings);
        }
      } catch (err: any) {
        // File read error — skip silently
        console.warn(`[content-safety] Could not read ${filePath}: ${err.message}`);
      }
    }

    const score = this.calculateSafetyScore({ findings } as SafetyReview);

    const review: SafetyReview = {
      reviewId,
      contentId: metadata?.contentId || undefined,
      timestamp: Date.now(),
      score,
      passed: score >= SAFETY_THRESHOLD,
      findings,
      reviewerPeerId: this.localPeerId,
    };

    // Store review
    this.reviews.unshift(review);
    if (this.reviews.length > MAX_REVIEWS) {
      this.reviews = this.reviews.slice(0, MAX_REVIEWS);
    }
    this.saveReviews();

    console.log(
      `[content-safety] Review ${reviewId.slice(0, 8)}: score=${score.toFixed(2)}, ` +
      `findings=${findings.length} (${findings.filter(f => f.severity === 'critical').length} critical, ` +
      `${findings.filter(f => f.severity === 'high').length} high)`,
    );

    return review;
  }

  // ── Score Calculation ──────────────────────────────────────

  /**
   * Calculate a safety score from 0 to 1 based on findings.
   * 1.0 = perfectly safe, 0.0 = extremely dangerous.
   */
  calculateSafetyScore(review: SafetyReview): number {
    if (review.findings.length === 0) return 1.0;

    // Severity weights (penalty per finding)
    const weights: Record<SafetyFinding['severity'], number> = {
      critical: 0.30,
      high: 0.15,
      medium: 0.08,
      low: 0.03,
    };

    let totalPenalty = 0;
    for (const finding of review.findings) {
      totalPenalty += weights[finding.severity] || 0.05;
    }

    // Clamp to [0, 1]
    return Math.max(0, Math.min(1, 1.0 - totalPenalty));
  }

  // ── Flagging ───────────────────────────────────────────────

  /**
   * Flag content for governance review.
   * Adds a flagged review entry with the given reason.
   */
  flagContent(contentId: string, reason: string): void {
    const review: SafetyReview = {
      reviewId: randomBytes(8).toString('hex'),
      contentId,
      timestamp: Date.now(),
      score: 0,
      passed: false,
      findings: [{
        severity: 'critical',
        category: 'harmful_content',
        description: `Manually flagged: ${reason}`,
      }],
      reviewerPeerId: this.localPeerId,
    };

    this.reviews.unshift(review);
    if (this.reviews.length > MAX_REVIEWS) {
      this.reviews = this.reviews.slice(0, MAX_REVIEWS);
    }
    this.saveReviews();

    console.log(`[content-safety] Content flagged: ${contentId} — ${reason}`);
  }

  // ── History ────────────────────────────────────────────────

  /**
   * Get review history, optionally filtered by content ID.
   */
  getReviewHistory(contentId?: string): SafetyReview[] {
    if (contentId) {
      return this.reviews.filter(r => r.contentId === contentId);
    }
    return [...this.reviews];
  }

  // ── Helpers ────────────────────────────────────────────────

  /**
   * Get line number from character index in content.
   */
  private getLineNumber(content: string, index: number): number {
    const lines = content.substring(0, index).split('\n');
    return lines.length;
  }

  /**
   * Check package.json dependencies for known vulnerable packages.
   */
  private checkDependencies(content: string, filePath: string, findings: SafetyFinding[]): void {
    try {
      const pkg = JSON.parse(content);
      const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };

      for (const dangerous of DANGEROUS_DEPENDENCIES) {
        if (allDeps[dangerous.name]) {
          findings.push({
            severity: dangerous.severity,
            category: 'vulnerability',
            description: `Dangerous dependency: ${dangerous.name} — ${dangerous.reason}`,
            file: filePath,
          });
        }
      }
    } catch {
      // Invalid package.json — skip
    }
  }

  // ── Persistence ────────────────────────────────────────────

  private loadReviews(): void {
    try {
      if (existsSync(this.reviewsPath)) {
        const data = JSON.parse(readFileSync(this.reviewsPath, 'utf-8'));
        if (Array.isArray(data)) {
          this.reviews = data.slice(0, MAX_REVIEWS);
        }
      }
    } catch {
      this.reviews = [];
    }
  }

  private saveReviews(): void {
    try {
      writeFileSync(this.reviewsPath, JSON.stringify(this.reviews, null, 2));
    } catch (err: any) {
      console.error(`[content-safety] Failed to save reviews: ${err.message}`);
    }
  }
}
