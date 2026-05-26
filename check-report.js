const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connect('wss://connect.anchorbrowser.io/?sessionId=b253f3e2-0749-4ddd-8d20-04a879149077');
  const page = await browser.newPage();

  const logs = [];
  page.on('console', msg => logs.push(msg.type() + ': ' + msg.text()));
  page.on('pageerror', err => logs.push('PAGE ERROR: ' + err.message));

  await page.goto('https://tunevault.app/report/19', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(3000);

  const title = await page.title();
  const hasReportContent = await page.evaluate(() => !!document.getElementById('reportContent'));
  const loadingState = await page.evaluate(() => {
    const el = document.getElementById('reportContent');
    if (!el) return 'NO reportContent element found';
    return el.innerHTML.substring(0, 200);
  });

  console.log('Title:', title);
  console.log('Has reportContent:', hasReportContent);
  console.log('reportContent HTML:', loadingState);
  console.log('Console logs:', JSON.stringify(logs, null, 2));

  await browser.close();
})().catch(e => console.error('Error:', e));