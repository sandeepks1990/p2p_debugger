const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const WMSClient = require('./wms-client');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Default WMS configuration
const DEFAULT_WMS_CONFIG = {
  wmsUrl: 'us1-sq3.wysemanagementsuite.com',
  groupToken: 'mahhTest@123'
};

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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get WMS configuration
app.get('/api/wms-config', (req, res) => {
  res.json(DEFAULT_WMS_CONFIG);
});

// Update WMS configuration
app.post('/api/wms-config', (req, res) => {
  const { wmsUrl, groupToken } = req.body;
  if (wmsUrl) DEFAULT_WMS_CONFIG.wmsUrl = wmsUrl;
  if (groupToken) DEFAULT_WMS_CONFIG.groupToken = groupToken;
  res.json(DEFAULT_WMS_CONFIG);
});

// Fetch TURN credentials from WMS
app.get('/api/turn-credentials', async (req, res) => {
  try {
    console.log('Fetching TURN credentials from WMS...');
    console.log('WMS URL:', DEFAULT_WMS_CONFIG.wmsUrl);
    console.log('Group Token:', DEFAULT_WMS_CONFIG.groupToken);

    const wmsClient = new WMSClient(DEFAULT_WMS_CONFIG.wmsUrl, DEFAULT_WMS_CONFIG.groupToken);
    const credentials = await wmsClient.getTurnCredentials();

    console.log('TURN credentials fetched successfully:', credentials);

    // Format for WebRTC
    const turnConfig = {
      urls: `turns:${credentials.turnServerURL}`,
      username: credentials.userID,
      credential: credentials.phrase
    };

    res.json({
      success: true,
      config: turnConfig,
      raw: credentials
    });
  } catch (error) {
    console.error('Error fetching TURN credentials:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.stack
    });
  }
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
