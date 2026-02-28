const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3456;
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  } else { res.writeHead(404); res.end(); }
});
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();
wss.on('connection', ws => {
  clients.add(ws);
  ws.on('message', data => {
    const msg = data.toString();
    clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
  });
  ws.on('close', () => clients.delete(ws));
});
server.listen(PORT, () => console.log('pando-chat listening on ' + PORT));
