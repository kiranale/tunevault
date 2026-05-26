// Simulate the nav-component.js buildNav for 'dashboard' type
// to check what dropdown HTML gets generated

const fs = require('fs');
const vm = require('vm');

// Create a mock DOM environment
const mockDoc = {
  getElementById: (id) => {
    if (id === 'nav-root') return { innerHTML: '', style: {} };
    return null;
  },
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {}
};
const mockWindow = {
  tvNav: undefined,
  tvNavToggleDropdown: undefined,
  tvNavToggleMobile: undefined,
  document: mockDoc,
  location: { pathname: '/dashboard', search: '' },
  innerWidth: 1400,
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ user: { is_admin: false } }) }),
  sessionStorage: { getItem: () => null, setItem: () => {} },
  localStorage: { getItem: () => null, setItem: () => {} }
};
mockDoc.defaultView = mockWindow;
mockDoc.createElement = (tag) => ({ tag, style: {}, innerHTML: '', classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} }, setAttribute: () => {}, appendChild: () => {}, insertBefore: () => {}, parentNode: null, querySelectorAll: () => [], querySelector: () => null });

// Load and execute nav-component.js
const navCode = fs.readFileSync('public/nav-component.js', 'utf8');
// Remove the DOMContentLoaded at the bottom
const cleanedCode = navCode.replace(/\/\/ Close dropdowns[\r\n]+document\//g, '// doc').replace(/\/\/ Keyboard navigation[\r\n]+document\//g, '// doc');
// Execute in mock context
try {
  const script = new vm.Script(cleanedCode);
  const context = vm.createContext(mockWindow);
  script.runInContext(context);

  console.log('tvNav defined:', typeof mockWindow.tvNav === 'object');
  console.log('init defined:', typeof mockWindow.tvNav.init);
  console.log('toggle defined:', typeof mockWindow.tvNavToggleDropdown);

  // Try to build nav
  if (mockWindow.tvNav && mockWindow.tvNav.init) {
    console.log('\nTrying init...');
    mockWindow.tvNav.init('dashboard');
    console.log('nav built successfully');
  }
} catch(e) {
  console.error('Error:', e.message);
}

// Check if the generated HTML has the right dropdown structure
console.log('\n--- Checking dropdown HTML generation ---');
// Extract the buildConnectionsDropdown logic
const connDropMatch = navCode.match(/function buildConnectionsDropdown[\u0000-\uffff]*?function buildDbOpsLink/);
if (connDropMatch) {
  console.log('buildConnectionsDropdown found, length:', connDropMatch[0].length);
}
console.log('nav-component.js size:', navCode.length, 'bytes');
console.log('Total lines:', navCode.split('\n').length);