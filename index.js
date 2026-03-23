require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

const adminRoutes = require('./routes/admin');
const voiceRoutes = require('./routes/voice');
const setupSockets = require('./socket');

const app = express();
const server = http.createServer(app);

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3000', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded POST data

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use('/api/admin', adminRoutes);
app.use('/api/voice', voiceRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ─── SOCKETS ──────────────────────────────────────────────────────────────────
setupSockets(io);

// Share io so voice routes can emit to admin panel
app.set('io', io);

// ─── MONGODB ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/construction-chat')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
