import WebSocket from 'ws';
const id = process.argv[2] || '6d14707b';
const ws = new WebSocket('ws://127.0.0.1:18900/ws?token=bullybuddy2026');
ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', sessionId: id })));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'scrollback') {
    const clean = msg.data.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
    console.log(clean.slice(-1500));
    ws.close();
  }
});
setTimeout(() => ws.close(), 3000);
