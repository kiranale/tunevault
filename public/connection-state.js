window.tvConn = {
  save: function(id) { localStorage.setItem('tv_conn', String(id)); },
  load: function() { return localStorage.getItem('tv_conn'); },

  // Normalize raw /api/connections response:
  // - filters out removed_connection rows
  // - adds a label field (display name for option text)
  parseList: function(data) {
    if (!Array.isArray(data)) return [];
    return data
      .filter(function(c) { return !c.removed_connection; })
      .map(function(c) {
        return Object.assign({}, c, {
          label: c.name || (c.host + (c.port ? ':' + c.port : ''))
        });
      });
  },

  // Restore last-used connection in a <select> element.
  // Sets sel.value to the saved ID only if it still exists in connections.
  bind: function(sel, connections) {
    var saved = localStorage.getItem('tv_conn');
    if (!saved) return;
    var found = connections.some(function(c) { return String(c.id) === saved; });
    if (found) sel.value = saved;
  }
};
