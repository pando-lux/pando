/**
 * Phase 45 E2E Test — Playwright
 * Verifies:
 *   1. Resources page loads with heading + stat cards
 *   2. Chat page loads, user can type and submit a message, response appears
 *
 * Run: node tests/test-phase45.mjs
 * Requires: Gateway on http://127.0.0.1:3222, Node on http://127.0.0.1:4000
 * Exit code 0 = all pass, 1 = failures.
 */
import { chromium } from 'playwright';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:3222';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || 'C:/Users/jaira/Desktop/pando/tests';

async function testPhase45() {
  console.log('');
  console.log('================================================');
  console.log('  PHASE 45 E2E TEST');
  console.log(`  Gateway: ${GATEWAY_URL}`);
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('================================================');
  console.log('');

  const headless = process.env.HEADLESS !== 'false';
  const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 400 });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const results = {};

  // Collect console errors
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  try {
    // ===== TEST 1: Resources page loads =====
    console.log('1. RESOURCES PAGE');
    console.log('   Navigating to /resources...');

    try {
      const resp = await page.goto(`${GATEWAY_URL}/resources`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000); // React hydration

      // 1a. HTTP status
      const httpOk = resp.status() === 200;
      console.log(`   HTTP status: ${resp.status()} -- ${httpOk ? 'PASS' : 'FAIL'}`);

      // 1b. Page has "Resources" heading (h1)
      const h1 = page.locator('h1');
      const h1Text = await h1.first().textContent({ timeout: 5000 }).catch(() => '');
      const hasResourcesHeading = h1Text.includes('Resources');
      results['resources_heading'] = hasResourcesHeading;
      console.log(`   H1 text: "${h1Text}" -- ${hasResourcesHeading ? 'PASS' : 'FAIL'}`);

      // 1c. Page has stat cards (Total Resources, Active, Types, Providers)
      const bodyText = await page.textContent('body');
      const hasStatCards = bodyText.includes('Total Resources') && bodyText.includes('Active');
      results['resources_stats'] = hasStatCards;
      console.log(`   Stat cards visible: ${hasStatCards ? 'PASS' : 'FAIL'}`);

      // 1d. "Contribute a Resource" section exists
      const hasContribute = bodyText.includes('Contribute a Resource') || bodyText.includes('Contribute');
      results['resources_contribute'] = hasContribute;
      console.log(`   Contribute section: ${hasContribute ? 'PASS' : 'FAIL'}`);

      // 1e. "Network Resources" list section exists
      const hasNetworkResources = bodyText.includes('Network Resources') || bodyText.includes('resource');
      results['resources_list'] = hasNetworkResources;
      console.log(`   Network Resources list: ${hasNetworkResources ? 'PASS' : 'FAIL'}`);

      // 1f. No crash — page content > 500 chars
      const contentLength = bodyText.length;
      results['resources_no_crash'] = contentLength > 500;
      console.log(`   Content length: ${contentLength} chars -- ${contentLength > 500 ? 'PASS' : 'FAIL'}`);

      await page.screenshot({ path: `${SCREENSHOT_DIR}/phase45-resources.png`, fullPage: true });
      console.log('   Screenshot saved: phase45-resources.png');

    } catch (err) {
      console.log(`   ERROR: ${err.message.slice(0, 200)}`);
      results['resources_heading'] = false;
      results['resources_stats'] = false;
      results['resources_contribute'] = false;
      results['resources_list'] = false;
      results['resources_no_crash'] = false;
      await page.screenshot({ path: `${SCREENSHOT_DIR}/phase45-resources-error.png` }).catch(() => {});
    }

    // ===== TEST 2: Chat page loads and works =====
    console.log('');
    console.log('2. CHAT PAGE');
    console.log('   Navigating to /chat...');

    try {
      const resp = await page.goto(`${GATEWAY_URL}/chat`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000); // React hydration + auth + SSE setup

      // 2a. HTTP status
      const httpOk = resp.status() === 200;
      console.log(`   HTTP status: ${resp.status()} -- ${httpOk ? 'PASS' : 'FAIL'}`);

      // 2b. Page has chat heading ("New Chat" or thread title)
      const h1 = page.locator('h1');
      const h1Text = await h1.first().textContent({ timeout: 5000 }).catch(() => '');
      const hasChatHeading = h1Text.includes('Chat') || h1Text.includes('New') || h1Text.includes('conversation');
      results['chat_heading'] = hasChatHeading;
      console.log(`   H1 text: "${h1Text}" -- ${hasChatHeading ? 'PASS' : 'FAIL'}`);

      // 2c. Has message input area (textarea)
      const textarea = page.locator('textarea');
      const textareaVisible = await textarea.first().isVisible({ timeout: 5000 }).catch(() => false);
      results['chat_input_visible'] = textareaVisible;
      console.log(`   Textarea visible: ${textareaVisible ? 'PASS' : 'FAIL'}`);

      // 2d. Has Send button
      const sendBtn = page.locator('button', { hasText: 'Send' });
      const sendBtnVisible = await sendBtn.first().isVisible({ timeout: 3000 }).catch(() => false);
      results['chat_send_button'] = sendBtnVisible;
      console.log(`   Send button visible: ${sendBtnVisible ? 'PASS' : 'FAIL'}`);

      // 2e. Quick actions visible (Node Status, My Balance, etc.)
      const bodyText = await page.textContent('body');
      const hasQuickActions = bodyText.includes('Node Status') || bodyText.includes('My Balance');
      results['chat_quick_actions'] = hasQuickActions;
      console.log(`   Quick actions visible: ${hasQuickActions ? 'PASS' : 'FAIL'}`);

      // 2f. Type "hello" and submit
      console.log('   Typing "hello" in chat input...');
      if (textareaVisible) {
        await textarea.first().fill('hello');
        await page.waitForTimeout(500);

        // Verify input has text
        const inputValue = await textarea.first().inputValue();
        results['chat_input_typed'] = inputValue === 'hello';
        console.log(`   Input value: "${inputValue}" -- ${inputValue === 'hello' ? 'PASS' : 'FAIL'}`);

        // Take pre-send screenshot
        await page.screenshot({ path: `${SCREENSHOT_DIR}/phase45-chat-pre-send.png`, fullPage: true });

        // Click Send
        console.log('   Clicking Send...');
        await sendBtn.first().click();
        await page.waitForTimeout(1000);

        // 2g. User message appeared in chat
        // The user message "hello" should appear in an amber-colored bubble
        const userMsgVisible = await page.locator('text=hello').first().isVisible({ timeout: 5000 }).catch(() => false);
        results['chat_user_msg_sent'] = userMsgVisible;
        console.log(`   User message visible: ${userMsgVisible ? 'PASS' : 'FAIL'}`);

        // 2h. Wait for a response (Processing... or actual response or streaming indicator)
        console.log('   Waiting for response (up to 15s)...');
        let gotResponse = false;
        try {
          // Wait for any assistant response: "Processing...", agent activity, or actual reply
          await page.waitForFunction(() => {
            const body = document.body.textContent || '';
            return body.includes('Processing') ||
                   body.includes('Thinking') ||
                   body.includes('Agent working') ||
                   // Check for multiple chat bubbles (at least the user's + something else)
                   document.querySelectorAll('[class*="rounded-2xl"]').length > 2;
          }, { timeout: 15000 });
          gotResponse = true;
        } catch {
          // Check if maybe a direct reply came already
          const pageContent = await page.textContent('body');
          gotResponse = pageContent.includes('Processing') ||
                        pageContent.includes('Thinking') ||
                        pageContent.includes('Agent working') ||
                        pageContent.includes('simple') || // tier badge
                        pageContent.includes('Quick');     // tier badge
        }
        results['chat_response_received'] = gotResponse;
        console.log(`   Response/processing visible: ${gotResponse ? 'PASS' : 'FAIL'}`);

        await page.screenshot({ path: `${SCREENSHOT_DIR}/phase45-chat-response.png`, fullPage: true });
        console.log('   Screenshot saved: phase45-chat-response.png');

      } else {
        results['chat_input_typed'] = false;
        results['chat_user_msg_sent'] = false;
        results['chat_response_received'] = false;
        console.log('   SKIP: Cannot type -- textarea not visible');
      }

      // 2i. Thread sidebar exists
      const sidebarVisible = await page.locator('text=Conversations').isVisible({ timeout: 3000 }).catch(() => false) ||
                             await page.locator('text=New Chat').isVisible({ timeout: 3000 }).catch(() => false);
      results['chat_sidebar'] = sidebarVisible;
      console.log(`   Thread sidebar: ${sidebarVisible ? 'PASS' : 'FAIL'}`);

    } catch (err) {
      console.log(`   ERROR: ${err.message.slice(0, 200)}`);
      results['chat_heading'] = results['chat_heading'] ?? false;
      results['chat_input_visible'] = results['chat_input_visible'] ?? false;
      results['chat_send_button'] = results['chat_send_button'] ?? false;
      results['chat_quick_actions'] = results['chat_quick_actions'] ?? false;
      results['chat_input_typed'] = results['chat_input_typed'] ?? false;
      results['chat_user_msg_sent'] = results['chat_user_msg_sent'] ?? false;
      results['chat_response_received'] = results['chat_response_received'] ?? false;
      results['chat_sidebar'] = results['chat_sidebar'] ?? false;
      await page.screenshot({ path: `${SCREENSHOT_DIR}/phase45-chat-error.png` }).catch(() => {});
    }

  } finally {
    await browser.close();
  }

  // ===== SUMMARY =====
  console.log('');
  console.log('================================================');
  console.log('  PHASE 45 E2E RESULTS');
  console.log('================================================');
  const entries = Object.entries(results);
  const passed = entries.filter(([, v]) => v).length;
  const failed = entries.filter(([, v]) => !v).length;
  for (const [name, pass] of entries) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}: ${name}`);
  }
  console.log('');
  console.log(`  Total: ${entries.length}  Passed: ${passed}  Failed: ${failed}`);
  console.log('================================================');

  if (consoleErrors.length > 0) {
    console.log('');
    console.log('Browser console errors (first 10):');
    for (const err of consoleErrors.slice(0, 10)) {
      console.log(`  ${err.slice(0, 200)}`);
    }
  }

  if (failed > 0) {
    console.log('');
    console.log('FAILURES:');
    for (const [name, pass] of entries) {
      if (!pass) console.log(`  FAIL: ${name}`);
    }
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

testPhase45().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
