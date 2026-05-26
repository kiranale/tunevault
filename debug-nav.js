const { chromium } = require('playwright');

const CDP_URL = 'wss://connect.anchorbrowser.io/?sessionId=a6f00e54-5950-45f3-8cab-74d3b849c802';

async function main() {
  console.log('=== TuneVault Nav Dropdown Debug ===\n');

  const consoleMessages = [];
  const consoleErrors = [];

  console.log('Connecting to CDP session...');
  const browser = await chromium.connectOverCDP(CDP_URL);
  console.log('Connected!\n');

  const contexts = browser.contexts();
  console.log('Browser contexts: ' + contexts.length);
  
  let page;
  if (contexts.length > 0 && contexts[0].pages().length > 0) {
    page = contexts[0].pages()[0];
    console.log('Reusing existing page: ' + page.url());
  } else {
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    page = await context.newPage();
    console.log('Created new page');
  }

  // Capture console messages
  page.on('console', msg => {
    const text = '[' + msg.type() + '] ' + msg.text();
    consoleMessages.push(text);
    if (msg.type() === 'error') consoleErrors.push(text);
  });
  page.on('pageerror', err => consoleErrors.push('[pageerror] ' + err.message));

  console.log('\nNavigating to https://tunevault-wney.polsia.app ...');
  await page.goto('https://tunevault-wney.polsia.app', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Page title: ' + (await page.title()));
  console.log('Page URL: ' + page.url());

  // Wait for nav to load
  console.log('\nWaiting for .tv-dropdown to appear...');
  try {
    await page.waitForSelector('.tv-dropdown', { timeout: 10000 });
    console.log('.tv-dropdown found!');
  } catch (e) {
    console.log('WARN: .tv-dropdown did NOT appear within 10s: ' + e.message);
  }

  await page.waitForTimeout(2000);

  // CHECK A: tvNavToggleDropdown in window scope
  console.log('\n--- CHECK A: tvNavToggleDropdown in window scope ---');
  const toggleExists = await page.evaluate(() => typeof window.tvNavToggleDropdown);
  console.log('typeof window.tvNavToggleDropdown: ' + toggleExists);

  // CHECK B: .tv-dropdown elements
  console.log('\n--- CHECK B: .tv-dropdown elements ---');
  const dropdownInfo = await page.evaluate(() => {
    const els = document.querySelectorAll('.tv-dropdown');
    return {
      count: els.length,
      details: Array.from(els).map((el, i) => ({
        index: i,
        tagName: el.tagName,
        id: el.id,
        classes: el.className,
        innerHTML_snippet: el.innerHTML.substring(0, 200)
      }))
    };
  });
  console.log('Count of .tv-dropdown: ' + dropdownInfo.count);
  dropdownInfo.details.forEach(d => {
    console.log('  [' + d.index + '] <' + d.tagName + '> id="' + d.id + '" class="' + d.classes + '"');
    console.log('       innerHTML: ' + d.innerHTML_snippet);
  });

  // CHECK C: .tv-dropdown-menu elements and display style
  console.log('\n--- CHECK C: .tv-dropdown-menu elements and display ---');
  const menuInfo = await page.evaluate(() => {
    const els = document.querySelectorAll('.tv-dropdown-menu');
    return {
      count: els.length,
      details: Array.from(els).map((el, i) => {
        const cs = window.getComputedStyle(el);
        return {
          index: i,
          tagName: el.tagName,
          id: el.id,
          classes: el.className,
          inlineDisplay: el.style.display,
          computedDisplay: cs.display,
          computedVisibility: cs.visibility,
          computedOpacity: cs.opacity,
          computedOverflow: cs.overflow,
          computedHeight: cs.height,
          computedMaxHeight: cs.maxHeight,
          parentClasses: el.parentElement ? el.parentElement.className : 'N/A'
        };
      })
    };
  });
  console.log('Count of .tv-dropdown-menu: ' + menuInfo.count);
  menuInfo.details.forEach(d => {
    console.log('  [' + d.index + '] <' + d.tagName + '> id="' + d.id + '" class="' + d.classes + '"');
    console.log('       inline display: "' + d.inlineDisplay + '"');
    console.log('       computed display: "' + d.computedDisplay + '", visibility: "' + d.computedVisibility + '", opacity: "' + d.computedOpacity + '"');
    console.log('       height: "' + d.computedHeight + '", max-height: "' + d.computedMaxHeight + '", overflow: "' + d.computedOverflow + '"');
    console.log('       parent class: "' + d.parentClasses + '"');
  });

  // CHECK D: Click the first .tv-dropdown button
  console.log('\n--- CHECK D: Click first .tv-dropdown button ---');
  const firstDropdownButton = await page.$('.tv-dropdown button');
  if (firstDropdownButton) {
    const btnText = await firstDropdownButton.innerText();
    console.log('Found button text: "' + btnText + '"');
    await firstDropdownButton.click();
    console.log('Clicked!');
    await page.waitForTimeout(500);
  } else {
    console.log('No .tv-dropdown button found, trying alternative selectors...');
    const altBtn = await page.$('[data-dropdown] button, .nav-item button, .dropdown-toggle');
    if (altBtn) {
      const altText = await altBtn.innerText().catch(() => 'N/A');
      console.log('Alt button text: "' + altText + '"');
      await altBtn.click();
      console.log('Clicked alt button');
      await page.waitForTimeout(500);
    } else {
      console.log('No dropdown button found at all');
    }
  }

  // CHECK E: .tv-open class after click
  console.log('\n--- CHECK E: .tv-open class after click ---');
  const openClassInfo = await page.evaluate(() => {
    const menus = document.querySelectorAll('.tv-dropdown-menu');
    const dropdowns = document.querySelectorAll('.tv-dropdown');
    return {
      menusWithOpen: Array.from(menus).filter(el => el.classList.contains('tv-open')).length,
      dropdownsWithOpen: Array.from(dropdowns).filter(el => el.classList.contains('tv-open')).length,
      allMenuClasses: Array.from(menus).map(el => el.className),
      allDropdownClasses: Array.from(dropdowns).map(el => el.className)
    };
  });
  console.log('Menus with .tv-open: ' + openClassInfo.menusWithOpen);
  console.log('Dropdowns with .tv-open: ' + openClassInfo.dropdownsWithOpen);
  console.log('All menu classes: ' + JSON.stringify(openClassInfo.allMenuClasses));
  console.log('All dropdown classes: ' + JSON.stringify(openClassInfo.allDropdownClasses));

  // CHECK F: Computed display after click
  console.log('\n--- CHECK F: Computed display of menu after click ---');
  const postClickMenuInfo = await page.evaluate(() => {
    const menus = document.querySelectorAll('.tv-dropdown-menu');
    return Array.from(menus).map((el, i) => {
      const cs = window.getComputedStyle(el);
      return {
        index: i,
        classes: el.className,
        computedDisplay: cs.display,
        computedVisibility: cs.visibility,
        computedOpacity: cs.opacity,
        computedPointerEvents: cs.pointerEvents,
        computedZIndex: cs.zIndex,
        boundingRect: JSON.stringify(el.getBoundingClientRect())
      };
    });
  });
  postClickMenuInfo.forEach(m => {
    console.log('  Menu[' + m.index + '] class="' + m.classes + '"');
    console.log('    display="' + m.computedDisplay + '" visibility="' + m.computedVisibility + '" opacity="' + m.computedOpacity + '"');
    console.log('    pointer-events="' + m.computedPointerEvents + '" z-index="' + m.computedZIndex + '"');
    console.log('    boundingRect=' + m.boundingRect);
  });

  // CHECK G: elementFromPoint at nav position
  console.log('\n--- CHECK G: Element at nav click position (300, 40) ---');
  const elemAtPoint = await page.evaluate(() => {
    const el = document.elementFromPoint(300, 40);
    if (el === null) return { found: false };
    const cs = window.getComputedStyle(el);
    const ancestors = [];
    let cur = el;
    for (let i = 0; i < 6 && cur; i++) {
      const acs = window.getComputedStyle(cur);
      ancestors.push({
        level: i,
        tag: cur.tagName,
        id: cur.id,
        class: cur.className,
        pointerEvents: acs.pointerEvents,
        zIndex: acs.zIndex,
        position: acs.position
      });
      cur = cur.parentElement;
    }
    return {
      found: true,
      tagName: el.tagName,
      id: el.id,
      class: el.className,
      pointerEvents: cs.pointerEvents,
      zIndex: cs.zIndex,
      position: cs.position,
      ancestors: ancestors
    };
  });
  console.log('Element at (300, 40): ' + JSON.stringify(elemAtPoint, null, 2));

  // CHECK H: nav-wrapper z-index and position
  console.log('\n--- CHECK H: nav-wrapper / nav-root z-index and position ---');
  const navLayerInfo = await page.evaluate(() => {
    const selectors = ['.nav-wrapper', '.nav-root', 'nav', 'header', '.site-header', '[class*="nav"]'];
    const results = [];
    selectors.forEach(sel => {
      const el = document.querySelector(sel);
      if (el) {
        const cs = window.getComputedStyle(el);
        results.push({
          selector: sel,
          tagName: el.tagName,
          id: el.id,
          classes: el.className,
          zIndex: cs.zIndex,
          position: cs.position,
          display: cs.display,
          overflow: cs.overflow,
          rect: JSON.stringify(el.getBoundingClientRect())
        });
      }
    });
    return results;
  });
  navLayerInfo.forEach(n => {
    console.log('  ' + n.selector + ': <' + n.tagName + '> id="' + n.id + '" class="' + n.classes.substring(0,80) + '"');
    console.log('    z-index="' + n.zIndex + '" position="' + n.position + '" display="' + n.display + '" overflow="' + n.overflow + '"');
    console.log('    rect=' + n.rect);
  });

  // CHECK I: High z-index overlay elements
  console.log('\n--- CHECK I: High z-index elements that might overlay nav ---');
  const overlayInfo = await page.evaluate(() => {
    const all = document.querySelectorAll('*');
    const high = [];
    for (const el of all) {
      const cs = window.getComputedStyle(el);
      const z = parseInt(cs.zIndex);
      if (!isNaN(z) && z > 100 && cs.position !== 'static') {
        const rect = el.getBoundingClientRect();
        high.push({
          tag: el.tagName,
          id: el.id,
          class: el.className.substring(0, 60),
          zIndex: z,
          position: cs.position,
          display: cs.display,
          rect: Math.round(rect.top) + ',' + Math.round(rect.left) + ',' + Math.round(rect.width) + 'x' + Math.round(rect.height)
        });
      }
    }
    return high.sort((a,b) => b.zIndex - a.zIndex).slice(0, 15);
  });
  overlayInfo.forEach(o => {
    console.log('  z=' + o.zIndex + ' <' + o.tag + '> id="' + o.id + '" class="' + o.class + '" pos=' + o.position + ' disp=' + o.display + ' rect=' + o.rect);
  });

  // CHECK J: CSS rules for .tv-dropdown-menu
  console.log('\n--- CHECK J: CSS rules for .tv-dropdown and .tv-open ---');
  const cssRules = await page.evaluate(() => {
    const results = [];
    try {
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules || sheet.rules; } catch(e) { continue; }
        for (const rule of rules) {
          if (rule.selectorText && (
            rule.selectorText.includes('tv-dropdown') ||
            rule.selectorText.includes('tv-open')
          )) {
            results.push({
              selector: rule.selectorText,
              cssText: rule.cssText.substring(0, 300)
            });
          }
        }
      }
    } catch(e) {
      results.push({ error: e.message });
    }
    return results;
  });
  if (cssRules.length === 0) {
    console.log('  (no matching CSS rules found)');
  }
  cssRules.forEach(r => {
    if (r.error) console.log('  CSS read error: ' + r.error);
    else console.log('  ' + r.selector + ' => ' + r.cssText);
  });

  // Check what JS is attached to the button
  console.log('\n--- CHECK K: Event listeners on .tv-dropdown button ---');
  const btnEventInfo = await page.evaluate(() => {
    const btn = document.querySelector('.tv-dropdown button');
    if (!btn) return { found: false };
    return {
      found: true,
      onclick: btn.onclick ? btn.onclick.toString().substring(0, 200) : null,
      hasClickListeners: typeof getEventListeners !== 'undefined' ? JSON.stringify(getEventListeners(btn)) : 'getEventListeners not available',
      dataAttrs: Array.from(btn.attributes).map(a => a.name + '=' + a.value)
    };
  });
  console.log('Button event info: ' + JSON.stringify(btnEventInfo, null, 2));

  // Check the full nav HTML
  console.log('\n--- CHECK L: Full nav HTML structure ---');
  const navHTML = await page.evaluate(() => {
    const nav = document.querySelector('nav') || document.querySelector('.nav-root') || document.querySelector('[class*="nav"]');
    return nav ? nav.outerHTML.substring(0, 2000) : 'No nav element found';
  });
  console.log(navHTML);

  // Screenshot
  console.log('\n--- SCREENSHOT ---');
  const screenshotPath = '/opt/polsia/workspaces/company-92001/agent-30/exec-3001811/tunevault/debug-nav-screenshot.png';
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log('Screenshot saved to: ' + screenshotPath);

  // Console messages
  console.log('\n--- CONSOLE MESSAGES captured ---');
  if (consoleMessages.length === 0) {
    console.log('  (none captured)');
  } else {
    consoleMessages.forEach(m => console.log('  ' + m));
  }

  console.log('\n--- CONSOLE ERRORS ---');
  if (consoleErrors.length === 0) {
    console.log('  (no errors)');
  } else {
    consoleErrors.forEach(e => console.log('  ' + e));
  }

  console.log('\n=== Debug complete ===');
  await browser.close();
}

main().catch(err => {
  console.error('FATAL ERROR: ' + err.message);
  console.error(err.stack);
  process.exit(1);
});
