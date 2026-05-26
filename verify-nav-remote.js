// Verify nav-component.js behavior via HTTP
const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'node verify-nav' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

async function main() {
  // Check nav-component.js
  const navJs = await fetch('https://tunevault-wney.polsia.app/nav-component.js');
  console.log('nav-component.js status:', navJs.status);
  console.log('nav-component.js size:', navJs.body.length);

  // Check if tvNavToggleDropdown exists
  const hasToggle = navJs.body.includes('function tvNavToggleDropdown');
  const hasDropdownBtn = navJs.body.includes('onclick="tvNavToggleDropdown');
  const hasCssRules = navJs.body.includes('.tv-dropdown-menu{display:none;}');
  console.log('Has tvNavToggleDropdown function:', hasToggle);
  console.log('Has onclick handler in HTML:', hasDropdownBtn);
  console.log('Has CSS hide rules:', hasCssRules);

  // Check dashboard.html
  const dash = await fetch('https://tunevault-wney.polsia.app/dashboard');
  console.log('\ndashboard.html status:', dash.status);
  console.log('Has nav-root:', dash.body.includes('id="nav-root"'));
  console.log('Has nav-component.js script:', dash.body.includes('/nav-component.js'));
  console.log('Has tvNav.init call:', dash.body.includes('tvNav.init'));

  // Check for DOMContentLoaded wrapper
  const hasDOMContentLoaded = dash.body.includes('DOMContentLoaded') && dash.body.includes('tvNav.init');
  console.log('Has DOMContentLoaded + tvNav.init pattern:', hasDOMContentLoaded);

  // Check the init pattern
  if (dash.body.includes('tvNav.init')) {
    const idx = dash.body.indexOf('tvNav.init');
    console.log('Context around tvNav.init:', dash.body.substring(idx - 50, idx + 100));
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });