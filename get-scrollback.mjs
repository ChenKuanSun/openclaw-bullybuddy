import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:18900/ws?token=bullybuddy2026');

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'subscribe', sessionId: '635f6edf' }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'scrollback') {
    const clean = msg.data.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
    console.log('=== SESSION OUTPUT ===');
    console.log(clean.slice(-3000));
    ws.close();
    process.exit(0);
  }
});

setTimeout(() => { console.log('Timeout'); process.exit(1); }, 3000);
