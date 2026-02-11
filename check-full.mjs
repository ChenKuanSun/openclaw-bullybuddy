import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:18900/ws?token=bullybuddy2026');
ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', sessionId: '0b9f374a' })));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'scrollback') {
    const clean = msg.data.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
    console.log('=== FULL OUTPUT ===');
    console.log(clean);
    ws.close();
  }
});
setTimeout(() => { ws.close(); }, 3000);
