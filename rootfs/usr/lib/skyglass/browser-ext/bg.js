// Talks to the Skyglass backend for the bar's Home / Close buttons.
const PORT = 7777;
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && (msg.cmd === 'close' || msg.cmd === 'home')) {
    fetch(`http://127.0.0.1:${PORT}/api/browser/close`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ home: msg.cmd === 'home' }),
    }).then(() => reply({ ok: true }), e => reply({ ok: false, error: String(e) }));
    return true; // reply asynchronously
  }
});
