// server.js — Brick City Brawl socket.io relay server
const { createServer } = require('http');
const { Server } = require('socket.io');

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// slot → socket.id map
const slots = { p1: null, p2: null };
const frags = { p1: 0, p2: 0 };

function slotOf(id) {
  if (slots.p1 === id) return 'p1';
  if (slots.p2 === id) return 'p2';
  return null;
}

io.on('connection', (socket) => {
  // Assign first available slot
  const slot = slots.p1 === null ? 'p1' : slots.p2 === null ? 'p2' : null;
  if (!slot) {
    socket.emit('full');
    socket.disconnect(true);
    return;
  }
  slots[slot] = socket.id;

  socket.emit('assigned', slot);
  socket.broadcast.emit('peer-joined', slot);

  // Tell the newly joined player if the other slot is already occupied
  const otherSlot = slot === 'p1' ? 'p2' : 'p1';
  if (slots[otherSlot] !== null) {
    socket.emit('peer-joined', otherSlot);
  }

  io.emit('frags', frags);

  // Relay movement state to the other player
  socket.on('state', (data) => {
    socket.broadcast.emit('peer-state', data);
  });

  // Local player died — award frag to the other slot
  socket.on('died', () => {
    const s = slotOf(socket.id);
    const enemy = s === 'p1' ? 'p2' : 'p1';
    frags[enemy]++;
    io.emit('frags', frags);
  });

  socket.on('disconnect', () => {
    const s = slotOf(socket.id);
    if (s) {
      slots[s] = null;
      frags[s] = 0;  // reset frags when player leaves
    }
    io.emit('peer-left');
    io.emit('frags', frags);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () =>
  console.log(`Brick City socket server listening on :${PORT}`)
);
