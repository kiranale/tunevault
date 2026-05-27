window.tvConn = { save: function(id) { localStorage.setItem('tv_conn', id); }, load: function() { return localStorage.getItem('tv_conn'); } };
