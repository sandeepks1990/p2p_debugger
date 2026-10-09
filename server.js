const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Store room data
const rooms = new Map();

// Generate 5-digit room ID
function generateRoomId() {
  let roomId;
  do {
    roomId = Math.floor(10000 + Math.random() * 90000).toString();
  } while (rooms.has(roomId));
  return roomId;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('create-room', (data) => {
    const roomId = generateRoomId();
    rooms.set(roomId, {
      host: socket.id,
      turnConfig: data.turnConfig,
      peer2Config: null,
      createdAt: new Date()
    });
    socket.join(roomId);
    socket.emit('room-created', { roomId, turnConfig: data.turnConfig });
    console.log(`Room ${roomId} created by ${socket.id}`);
  });

  socket.on('join-room', (data) => {
    const { roomId, turnConfig } = data;
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    if (room.peer2Config) {
      socket.emit('error', { message: 'Room already has 2 peers' });
      return;
    }

    // If Peer 2 didn't provide credentials, use the pre-configured ones from Peer 1
    room.peer2Config = Object.keys(turnConfig).length > 0 ? turnConfig : room.turnConfig;
    socket.join(roomId);

    // Notify both peers
    io.to(room.host).emit('peer-joined', { turnConfig: room.peer2Config });
    socket.emit('room-joined', { turnConfig: room.turnConfig });

    console.log(`Peer ${socket.id} joined room ${roomId}`);
  });

  socket.on('signal', (data) => {
    const { roomId, signal, type } = data;
    const room = rooms.get(roomId);

    if (!room) return;

    // Send signal to the other peer
    const targetSocket = room.host === socket.id ? 
      Array.from(io.sockets.adapter.rooms.get(roomId) || []).find(id => id !== socket.id) :
      room.host;

    if (targetSocket) {
      io.to(targetSocket).emit('signal', { signal, type });
    }
  });

  socket.on('ice-candidate', (data) => {
    const { roomId, candidate } = data;
    const room = rooms.get(roomId);

    if (!room) return;

    const targetSocket = room.host === socket.id ? 
      Array.from(io.sockets.adapter.rooms.get(roomId) || []).find(id => id !== socket.id) :
      room.host;

    if (targetSocket) {
      io.to(targetSocket).emit('ice-candidate', { candidate });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // Clean up rooms where this socket was host
    for (const [roomId, room] of rooms.entries()) {
      if (room.host === socket.id) {
        rooms.delete(roomId);
        io.to(roomId).emit('host-disconnected');
        console.log(`Room ${roomId} deleted`);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
