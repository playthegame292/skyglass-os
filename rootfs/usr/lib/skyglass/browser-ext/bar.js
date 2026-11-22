// Samsung-style navigation bar at the bottom of every page: Close · Home · Back.
// Lives in a closed shadow root so no website can restyle or break it.
(() => {
  if (window.top !== window || document.getElementById('skyglass-navbar')) return;
  const H = 52;
  const host = document.createElement('div');
  host.id = 'skyglass-navbar';
  host.style.cssText = `all:initial;position:fixed;left:0;right:0;bottom:0;height:${H}px;z-index:2147483647;`;
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .bar { height: ${H}px; display: flex; align-items: center; justify-content: space-around;
        background: linear-gradient(180deg, rgba(250,253,255,.96), rgba(214,236,252,.96));
        border-top: 1px solid rgba(255,255,255,.9); box-shadow: 0 -2px 14px rgba(20,80,140,.25);
        font: 600 12px system-ui, sans-serif; -webkit-user-select: none; user-select: none; }
      button { all: unset; width: 33%; height: 100%; display: flex; align-items: center; justify-content: center; }
      button:active span { background: radial-gradient(circle, rgba(60,160,255,.35), transparent 70%); }
      span { width: 46px; height: 40px; border-radius: 20px; display: flex; align-items: center; justify-content: center; }
      svg { width: 24px; height: 24px; fill: none; stroke: #1a5c9a; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
    </style>
    <div class="bar">
      <button data-cmd="close" title="Close browser"><span><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></span></button>
      <button data-cmd="home" title="Home"><span><svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="5"/></svg></span></button>
      <button data-cmd="back" title="Back"><span><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></span></button>
    </div>`;
  const close = cmd => {
    try { chrome.runtime.sendMessage({ cmd }); } catch (e) { /* extension reloaded: the power button still works */ }
  };
  root.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const cmd = b.dataset.cmd;
    if (cmd === 'back') { history.length > 1 ? history.back() : close('close'); }
    else close(cmd);
  });
  const mount = () => {
    (document.body || document.documentElement).append(host);
    // keep the page's last line visible above the bar
    document.documentElement.style.setProperty('scroll-padding-bottom', H + 'px');
    if (document.body) document.body.style.setProperty('margin-bottom', H + 'px', 'important');
  };
  mount();
  // some single-page sites wipe <body>; put the bar back if that happens
  new MutationObserver(() => { if (!host.isConnected) mount(); }).observe(document.documentElement, { childList: true, subtree: false });
})();
