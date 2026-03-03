// server.js — Brick City multiplayer server (socket.io + Vite dev middleware)
import { createServer } from 'http';
import { createServer as createViteServer } from 'vite';
import { Server } from 'socket.io';
import express from 'express';

const app = express();

// Vite dev server as middleware (HMR, module resolution)
const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: 'spa',
});
app.use(vite.middlewares);

const httpServer = createServer(app);
const io = new Server(httpServer);

// ── Game state ─────────────────────────────────────────────────────────────
const occupied  = [false, false];   // slot 0 = P1 (red), slot 1 = P2 (blue)
const fragScores = [0, 0];

io.on('connection', (socket) => {
  // Assign the first free player slot
  const mySlot = occupied.findIndex(s => !s);

  if (mySlot === -1) {
    socket.emit('full');
    socket.disconnect();
    return;
  }
  occupied[mySlot] = true;
  console.log(`[server] Player ${mySlot + 1} connected (${socket.id})`);

  // Tell this client its slot and current frag counts
  socket.emit('init', { slot: mySlot, frags: [...fragScores] });

  // Notify the peer that a new player joined
  socket.broadcast.emit('peer_joined', { slot: mySlot });

  // Relay this player's world state to the peer (~20 Hz)
  socket.on('state', (data) => {
    socket.broadcast.emit('peer_state', { slot: mySlot, ...data });
  });

  // This player was killed — award a frag to the opponent
  socket.on('killed', () => {
    const killer = 1 - mySlot;
    fragScores[killer]++;
    io.emit('frag_update', { frags: [...fragScores], killer, victim: mySlot });
  });

  socket.on('disconnect', () => {
    occupied[mySlot] = false;
    console.log(`[server] Player ${mySlot + 1} disconnected`);
    io.emit('peer_disconnected', { slot: mySlot });
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🏙️  Brick City → http://localhost:${PORT}`);
  console.log('   Open a second tab/machine for Player 2');
});
