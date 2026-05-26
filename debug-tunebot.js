const { chromium } = require('playwright');

(async () => {
  const SCREENSHOT_DIR = process.env.TMPDIR + '/claude-0';

  const browser = await chromium.connectOverCDP('wss://connect.anchorbrowser.io/?sessionId=62dfaf07-d492-4691-a78a-9d1d20df29fa');
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();

  console.log('Connected to browser. Current URL:', page.url());

  // Navigate to a public page that includes tunebot.js (no auth required)
  await page.goto('https://tunevault-wney.polsia.app/pricing', { waitUntil: 'networkidle' });
  console.log('After navigation URL:', page.url());

  // Wait for TuneBot FAB to appear
  await page.waitForSelector('#tunebot-fab', { timeout: 15000 });
  console.log('FAB element found');

  // Check initial FAB styles
  const fabStyles = await page.evaluate(function() {
    var fab = document.getElementById('tunebot-fab');
    var computed = window.getComputedStyle(fab);
    return {
      inlineStyle: {
        bottom: fab.style.bottom,
        right: fab.style.right,
        top: fab.style.top,
        left: fab.style.left,
        position: fab.style.position,
      },
      computed: {
        bottom: computed.bottom,
        right: computed.right,
        top: computed.top,
        left: computed.left,
        position: computed.position,
      },
      rect: fab.getBoundingClientRect().toJSON(),
      outerHTML_snippet: fab.outerHTML.substring(0, 200)
    };
  });
  console.log('Initial FAB styles:', JSON.stringify(fabStyles, null, 2));

  // Take screenshot before
  await page.screenshot({ path: SCREENSHOT_DIR + '/before-drag.png', fullPage: false });
  console.log('Screenshot saved: before-drag.png');

  // Click FAB to open panel
  await page.click('#tunebot-fab');
  await page.waitForTimeout(800);

  // Check panel is open
  const panelVisible = await page.evaluate(function() {
    var panel = document.getElementById('tunebot-panel');
    if (panel === null) return { error: 'panel not found' };
    var computed = window.getComputedStyle(panel);
    return {
      inlineOpacity: panel.style.opacity,
      inlinePointerEvents: panel.style.pointerEvents,
      inlineTop: panel.style.top,
      inlineLeft: panel.style.left,
      inlineBottom: panel.style.bottom,
      inlineRight: panel.style.right,
      computedDisplay: computed.display,
      computedOpacity: computed.opacity,
      rect: panel.getBoundingClientRect().toJSON()
    };
  });
  console.log('Panel state after click:', JSON.stringify(panelVisible, null, 2));

  // Get header position
  const headerRect = await page.evaluate(function() {
    var header = document.getElementById('tb-header');
    if (header === null) return null;
    var computed = window.getComputedStyle(header);
    return {
      rect: header.getBoundingClientRect().toJSON(),
      cursor: computed.cursor,
      innerHTML_snippet: header.innerHTML.substring(0, 100)
    };
  });
  console.log('Header rect:', JSON.stringify(headerRect, null, 2));

  // Screenshot with panel open
  await page.screenshot({ path: SCREENSHOT_DIR + '/panel-open.png', fullPage: false });
  console.log('Screenshot saved: panel-open.png');

  if (headerRect && headerRect.rect.width > 0) {
    var startX = headerRect.rect.left + headerRect.rect.width / 2;
    var startY = headerRect.rect.top + headerRect.rect.height / 2;

    console.log('Starting drag from (' + startX + ', ' + startY + ')');

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.waitForTimeout(100);

    // Move incrementally - 100px left, 100px up
    for (var i = 0; i < 10; i++) {
      await page.mouse.move(startX - i * 10, startY - i * 10);
      await page.waitForTimeout(50);
    }

    // Check positions mid-drag
    const midDragState = await page.evaluate(function() {
      var fab = document.getElementById('tunebot-fab');
      var panel = document.getElementById('tunebot-panel');
      return {
        fab: {
          styleLeft: fab.style.left,
          styleTop: fab.style.top,
          styleBottom: fab.style.bottom,
          styleRight: fab.style.right,
          rect: fab.getBoundingClientRect().toJSON()
        },
        panel: {
          styleLeft: panel.style.left,
          styleTop: panel.style.top,
          styleBottom: panel.style.bottom,
          styleRight: panel.style.right,
          rect: panel.getBoundingClientRect().toJSON()
        }
      };
    });
    console.log('Mid-drag state:', JSON.stringify(midDragState, null, 2));

    await page.mouse.up();
    await page.waitForTimeout(300);

    // Final state
    const finalState = await page.evaluate(function() {
      var fab = document.getElementById('tunebot-fab');
      var panel = document.getElementById('tunebot-panel');
      return {
        fab: {
          styleLeft: fab.style.left,
          styleTop: fab.style.top,
          styleBottom: fab.style.bottom,
          styleRight: fab.style.right,
          rect: fab.getBoundingClientRect().toJSON()
        },
        panel: {
          styleLeft: panel.style.left,
          styleTop: panel.style.top,
          styleBottom: panel.style.bottom,
          styleRight: panel.style.right,
          rect: panel.getBoundingClientRect().toJSON()
        },
        localStorage_tvBotPosition: localStorage.getItem('tvBotPosition')
      };
    });
    console.log('Final state after drag:', JSON.stringify(finalState, null, 2));

    await page.screenshot({ path: SCREENSHOT_DIR + '/after-drag.png', fullPage: false });
    console.log('Screenshot saved: after-drag.png');

    // Position relationship analysis
    const positionAnalysis = await page.evaluate(function() {
      var fab = document.getElementById('tunebot-fab');
      var panel = document.getElementById('tunebot-panel');
      var fabRect = fab.getBoundingClientRect();
      var panelRect = panel.getBoundingClientRect();

      return {
        fabParent: fab.parentElement.id || fab.parentElement.tagName,
        panelParent: panel.parentElement.id || panel.parentElement.tagName,
        fabComputedPosition: window.getComputedStyle(fab).position,
        panelComputedPosition: window.getComputedStyle(panel).position,
        // FAB bottom vs panel top gap (expected ~12px based on openPanel getPanelAnchor)
        panelBottomToFabTopGap: fabRect.top - panelRect.bottom,
        // Panel right alignment vs FAB right
        panelRightVsFabRight: panelRect.right - fabRect.right,
        // Panel left vs FAB left
        panelLeftVsFabLeft: panelRect.left - fabRect.left,
        fabRect: fabRect.toJSON(),
        panelRect: panelRect.toJSON()
      };
    });
    console.log('Position relationship analysis:', JSON.stringify(positionAnalysis, null, 2));
  } else {
    console.log('ERROR: Header not found or has no width, cannot perform drag test');
  }

  await browser.close();
  console.log('Browser closed.');
})().catch(function(err) {
  console.error('Script error:', err.message);
  console.error(err.stack);
  process.exit(1);
});