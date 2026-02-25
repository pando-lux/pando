import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:3222';
const results = [];

function pass(name) { results.push({ name, status: 'PASS' }); console.log(`  ✓ ${name}`); }
function fail(name, err) { results.push({ name, status: 'FAIL', error: String(err).slice(0, 120) }); console.log(`  ✗ ${name}: ${err}`); }

async function run() {
  const headless = process.env.HEADLESS !== 'false';
  const browser = await chromium.launch({ headless, slowMo: headless ? 0 : 300 });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  // ============ 1. HOMEPAGE ============
  console.log('\n=== 1. Homepage ===');
  try {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
    const title = await page.textContent('h1');
    title ? pass('homepage_h1: ' + title.slice(0, 50)) : fail('homepage_h1', 'No h1 found');
    const bodyLen = (await page.textContent('body')).length;
    bodyLen > 200 ? pass('homepage_content_loaded') : fail('homepage_content_loaded', 'Too short: ' + bodyLen);
    await page.screenshot({ path: 'tests/e2e-home.png', fullPage: true });
    pass('homepage_screenshot');
  } catch (e) { fail('homepage', e.message); }

  await page.waitForTimeout(1000);

  // ============ 2. CHAT ============
  console.log('\n=== 2. Chat ===');
  try {
    await page.goto(BASE + '/chat', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);
    const chatH1 = await page.textContent('h1');
    chatH1 ? pass('chat_h1: ' + chatH1.slice(0, 50)) : fail('chat_h1', 'No h1');

    // Find input
    const textarea = page.locator('textarea').first();
    const inputVisible = await textarea.isVisible().catch(() => false);
    inputVisible ? pass('chat_input_visible') : fail('chat_input_visible', 'No textarea');

    if (inputVisible) {
      // Type and send
      await textarea.fill('what is my balance?');
      pass('chat_typed_message');

      // Find and click send button
      const sendBtn = page.locator('button[type="submit"], button:has-text("Send")').first();
      await sendBtn.click();
      pass('chat_clicked_send');

      // Wait for response
      await page.waitForTimeout(5000);
      const messages = await page.locator('[class*="message"], [class*="bubble"], p').count();
      messages > 0 ? pass('chat_response_appeared: ' + messages + ' elements') : fail('chat_response_appeared', 'No response');
    }

    await page.screenshot({ path: 'tests/e2e-chat.png', fullPage: true });
    pass('chat_screenshot');
  } catch (e) { fail('chat', e.message); }

  await page.waitForTimeout(1000);

  // ============ 3. WALLET ============
  console.log('\n=== 3. Wallet ===');
  try {
    await page.goto(BASE + '/wallet', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);
    const walletBody = await page.textContent('body');
    walletBody.toLowerCase().includes('balance') || walletBody.toLowerCase().includes('lux') || walletBody.toLowerCase().includes('wallet')
      ? pass('wallet_has_balance_info')
      : fail('wallet_has_balance_info', 'No balance/lux/wallet text found');
    walletBody.length > 200 ? pass('wallet_content_loaded') : fail('wallet_content_loaded', 'Too short');
    await page.screenshot({ path: 'tests/e2e-wallet.png', fullPage: true });
    pass('wallet_screenshot');
  } catch (e) { fail('wallet', e.message); }

  await page.waitForTimeout(1000);

  // ============ 4. NETWORK ============
  console.log('\n=== 4. Network ===');
  try {
    await page.goto(BASE + '/network', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);
    const netBody = await page.textContent('body');
    netBody.length > 100 ? pass('network_loaded') : fail('network_loaded', 'Too short');
    await page.screenshot({ path: 'tests/e2e-network.png', fullPage: true });
    pass('network_screenshot');
  } catch (e) { fail('network', e.message); }

  await page.waitForTimeout(1000);

  // ============ 5. GOVERNANCE ============
  console.log('\n=== 5. Governance ===');
  try {
    await page.goto(BASE + '/governance', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);
    const govBody = await page.textContent('body');
    govBody.toLowerCase().includes('governance') || govBody.toLowerCase().includes('proposal')
      ? pass('governance_has_content')
      : fail('governance_has_content', 'No governance/proposal text');
    await page.screenshot({ path: 'tests/e2e-governance.png', fullPage: true });
    pass('governance_screenshot');
  } catch (e) { fail('governance', e.message); }

  await page.waitForTimeout(1000);

  // ============ 6. PROJECTS ============
  console.log('\n=== 6. Projects ===');
  try {
    await page.goto(BASE + '/projects', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);
    const projBody = await page.textContent('body');
    projBody.toLowerCase().includes('project')
      ? pass('projects_has_content')
      : fail('projects_has_content', 'No project text');

    // Try creating a project
    const nameInput = page.locator('input[placeholder*="name" i], input[name="name"]').first();
    const nameVisible = await nameInput.isVisible().catch(() => false);
    if (nameVisible) {
      await nameInput.fill('Test E2E Project');
      pass('projects_filled_name');

      // Look for submit/create button
      const createBtn = page.locator('button:has-text("Create"), button[type="submit"]').first();
      const btnVisible = await createBtn.isVisible().catch(() => false);
      if (btnVisible) {
        await createBtn.click();
        await page.waitForTimeout(3000);
        pass('projects_clicked_create');
      }
    } else {
      pass('projects_no_create_form (may need auth)');
    }

    await page.screenshot({ path: 'tests/e2e-projects.png', fullPage: true });
    pass('projects_screenshot');
  } catch (e) { fail('projects', e.message); }

  await page.waitForTimeout(1000);

  // ============ 7. RESOURCES ============
  console.log('\n=== 7. Resources ===');
  try {
    await page.goto(BASE + '/resources', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);
    const resBody = await page.textContent('body');
    resBody.toLowerCase().includes('resource')
      ? pass('resources_has_content')
      : fail('resources_has_content', 'No resource text');

    // Check for stats cards
    const statsText = resBody.toLowerCase();
    (statsText.includes('total') || statsText.includes('active') || statsText.includes('provider'))
      ? pass('resources_has_stats')
      : fail('resources_has_stats', 'No stats found');

    await page.screenshot({ path: 'tests/e2e-resources.png', fullPage: true });
    pass('resources_screenshot');
  } catch (e) { fail('resources', e.message); }

  await page.waitForTimeout(1000);

  // ============ 8. SCHEDULER ============
  console.log('\n=== 8. Scheduler ===');
  try {
    await page.goto(BASE + '/scheduler', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);
    const schedBody = await page.textContent('body');
    schedBody.length > 100 ? pass('scheduler_loaded') : fail('scheduler_loaded', 'Too short');
    await page.screenshot({ path: 'tests/e2e-scheduler.png', fullPage: true });
    pass('scheduler_screenshot');
  } catch (e) { fail('scheduler', e.message); }

  await page.waitForTimeout(1000);

  // ============ 9. MONITOR ============
  console.log('\n=== 9. Monitor ===');
  try {
    await page.goto(BASE + '/monitor', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);
    const monBody = await page.textContent('body');
    monBody.length > 100 ? pass('monitor_loaded') : fail('monitor_loaded', 'Too short');
    await page.screenshot({ path: 'tests/e2e-monitor.png', fullPage: true });
    pass('monitor_screenshot');
  } catch (e) { fail('monitor', e.message); }

  await page.waitForTimeout(1000);

  // ============ 10. EXPLORE ============
  console.log('\n=== 10. Explore ===');
  try {
    await page.goto(BASE + '/explore', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);
    const expBody = await page.textContent('body');
    expBody.length > 100 ? pass('explore_loaded') : fail('explore_loaded', 'Too short');
    await page.screenshot({ path: 'tests/e2e-explore.png', fullPage: true });
    pass('explore_screenshot');
  } catch (e) { fail('explore', e.message); }

  await page.waitForTimeout(1000);

  // ============ 11. REGISTER PAGE ============
  console.log('\n=== 11. Register ===');
  try {
    await page.goto(BASE + '/register', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);
    const registerBody = await page.textContent('body');
    (registerBody.toLowerCase().includes('register') || registerBody.toLowerCase().includes('username') || registerBody.toLowerCase().includes('password') || registerBody.toLowerCase().includes('create'))
      ? pass('register_has_form')
      : fail('register_has_form', 'No register/username/password text');
    await page.screenshot({ path: 'tests/e2e-register.png', fullPage: true });
    pass('register_screenshot');
  } catch (e) { fail('register', e.message); }

  await page.waitForTimeout(1000);

  // ============ 12. LOGIN PAGE ============
  console.log('\n=== 12. Login ===');
  try {
    await page.goto(BASE + '/login', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);
    const loginBody = await page.textContent('body');
    (loginBody.toLowerCase().includes('login') || loginBody.toLowerCase().includes('sign in') || loginBody.toLowerCase().includes('username'))
      ? pass('login_has_form')
      : fail('login_has_form', 'No login text');
    await page.screenshot({ path: 'tests/e2e-login.png', fullPage: true });
    pass('login_screenshot');
  } catch (e) { fail('login', e.message); }

  // ============ SUMMARY ============
  console.log('\n\n========================================');
  console.log('           E2E TEST SUMMARY');
  console.log('========================================\n');

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;

  for (const r of results) {
    console.log(`  ${r.status === 'PASS' ? '✓' : '✗'} ${r.name}${r.error ? ' — ' + r.error : ''}`);
  }

  console.log(`\n  Total: ${passed} PASS, ${failed} FAIL out of ${results.length}\n`);

  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
