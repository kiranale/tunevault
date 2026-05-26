const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('wss://connect.anchorbrowser.io/?sessionId=b181b783-3cba-41bf-8b24-37a70b38ff21');
  const page = await browser.newPage();
  await page.goto('https://tunevault-wney.polsia.app/dashboard');
  await page.waitForTimeout(3000);

  // Check if nav is rendered
  const navExists = await page.evaluate(() => Boolean(document.getElementById('nav-root')));
  console.log('nav-root exists:', navExists);

  const navHTML = await page.evaluate(() => {
    const nav = document.getElementById('nav-root');
    return nav ? nav.innerHTML.substring(0, 800) : 'not found';
  });
  console.log('nav HTML:', navHTML);

  // Check if tvNav is defined
  const tvNavExists = await page.evaluate(() => typeof window.tvNav);
  console.log('tvNav type:', tvNavExists);

  // Check if tvNavToggleDropdown is defined
  const toggleFn = await page.evaluate(() => typeof window.tvNavToggleDropdown);
  console.log('tvNavToggleDropdown type:', toggleFn);

  // Check dropdown buttons
  const dropdownBtns = await page.evaluate(() => {
    const btns = document.querySelectorAll('[onclick*="tvNavToggleDropdown"]');
    return btns.length;
  });
  console.log('dropdown buttons with tvNavToggleDropdown:', dropdownBtns);

  // Check if tv-dropdown-menu has correct CSS class
  const menuInfo = await page.evaluate(() => {
    const menus = document.querySelectorAll('.tv-dropdown-menu');
    return {
      count: menus.length,
      firstHasTvOpen: menus[0] ? menus[0].classList.contains('tv-open') : false,
      computedDisplay: menus[0] ? window.getComputedStyle(menus[0]).display : 'N/A'
    };
  });
  console.log('dropdown menus:', JSON.stringify(menuInfo));

  // Try clicking the Connections button
  const connectionsBtn = await page.evaluate(() => {
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      if (btn.textContent.includes('Connections')) {
        return btn.outerHTML;
      }
    }
    return 'not found';
  });
  console.log('Connections button:', connectionsBtn.substring(0, 200));

  await browser.disconnect();
  console.log('Done');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });