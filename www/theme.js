/* apply the saved theme before first paint */
(function () {
  var t = 'light';
  try { t = JSON.parse(localStorage.getItem('reflow:theme')) || 'light'; } catch (e) {}
  var dark = t === 'dark' || (t === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
