import type { TestEvaluator, PlaybookStep } from '../types';

// ── BasicEvaluator ───────────────────────────────────────────────────
// No AI required. Checks if the page has meaningful content and is
// free of obvious error indicators.

export class BasicEvaluator implements TestEvaluator {
  async evaluate(
    step: PlaybookStep,
    context: {
      pageUrl: string;
      pageTitle: string;
      screenshotPath?: string;
      htmlSnippet?: string;
    },
  ): Promise<{
    passed: boolean;
    actual: string;
    notes: string;
    suggestedAction?: undefined;
    suggestedTarget?: undefined;
  }> {
    const snippet = context.htmlSnippet || '';
    const hasContent = snippet.length > 100;
    const errorPattern = /\b(error|404|500|not found|crashed|exception|internal server error)\b/i;
    const hasError = errorPattern.test(snippet) || errorPattern.test(context.pageTitle);

    if (hasError) {
      return {
        passed: false,
        actual: `Page appears to have errors. URL: ${context.pageUrl}, Title: ${context.pageTitle}`,
        notes: `Error indicators detected on page. Step: ${step.action} ${step.target || ''}`.trim(),
      };
    }

    if (!hasContent) {
      return {
        passed: false,
        actual: `Page has very little content (${snippet.length} chars). URL: ${context.pageUrl}`,
        notes: 'Page content is suspiciously short — may be blank or broken',
      };
    }

    return {
      passed: true,
      actual: `Page has content (${snippet.length} chars), no obvious errors. URL: ${context.pageUrl}`,
      notes: 'Page has content, no obvious errors detected',
    };
  }
}

// ── AIEvaluator ──────────────────────────────────────────────────────
// Pluggable AI-powered evaluator. Falls back to BasicEvaluator when
// no API key is available. Extend with any AI provider.

export class AIEvaluator implements TestEvaluator {
  private apiKey: string;
  private model: string;
  private fallback: BasicEvaluator;

  constructor(options?: { apiKey?: string; model?: string }) {
    this.apiKey = options?.apiKey
      || process.env.ANTHROPIC_API_KEY
      || process.env.OPENAI_API_KEY
      || '';
    this.model = options?.model || 'claude-sonnet-4-6';
    this.fallback = new BasicEvaluator();
  }

  async evaluate(
    step: PlaybookStep,
    context: {
      pageUrl: string;
      pageTitle: string;
      screenshotPath?: string;
      htmlSnippet?: string;
    },
  ): Promise<{
    passed: boolean;
    actual: string;
    notes: string;
    suggestedAction?: undefined;
    suggestedTarget?: undefined;
  }> {
    if (!this.apiKey) {
      // No API key available — delegate to basic evaluation
      return this.fallback.evaluate(step, context);
    }

    // TODO: Wire to actual AI API (Anthropic or OpenAI)
    //
    // The evaluation prompt would be:
    //   "You are a QA tester. Review this page snapshot and screenshot.
    //    Step being tested: {step.action} {step.target}
    //    Expected: {step.verify}
    //    Page URL: {context.pageUrl}
    //    Page title: {context.pageTitle}
    //    Page content: {context.htmlSnippet}
    //    Report: passed/failed, any bugs, UX issues, or suggestions."
    //
    // For now, delegate to BasicEvaluator until AI integration is wired.
    return this.fallback.evaluate(step, context);
  }
}
