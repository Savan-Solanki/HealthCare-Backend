const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const jwt = require("jsonwebtoken");
const { getRedisClient, isRedisAvailable } = require("./redis");
const User = require("../models/User");
const PatientUser = require("../models/PatientUser");
const logger = require("../utils/logger");

let io = null;

const initSocketIO = (httpServer, allowedOrigins) => {
  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  // Attach Redis adapter if Redis is available
  if (isRedisAvailable()) {
    const pubClient = getRedisClient();
    // Socket.IO redis adapter requires a duplicate client for subscribing
    const subClient = pubClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
    logger.info("Socket.IO Redis adapter configured successfully.");
  } else {
    logger.warn("Redis is unavailable. Running Socket.IO on local in-memory adapter.");
  }

  // 1. Patient Namespace
  const patientNs = io.of("/patient");
  patientNs.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      if (!token) return next(new Error("Authentication error: Token is required"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const patient = await PatientUser.findById(decoded.id);

      if (!patient) return next(new Error("Authentication error: Patient not found"));

      socket.user = patient;
      next();
    } catch (err) {
      next(new Error("Authentication error: Invalid token"));
    }
  });

  patientNs.on("connection", (socket) => {
    const userId = String(socket.user._id);
    socket.join(`user:${userId}`);
    logger.info(`Patient connected to websocket: user:${userId}`);

    socket.on("disconnect", () => {
      logger.info(`Patient disconnected: user:${userId}`);
    });
  });

  // 2. Staff Namespace
  const staffNs = io.of("/staff");
  staffNs.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      if (!token) return next(new Error("Authentication error: Token is required"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id);

      if (!user) return next(new Error("Authentication error: User not found"));

      socket.user = user;
      next();
    } catch (err) {
      next(new Error("Authentication error: Invalid token"));
    }
  });

  staffNs.on("connection", (socket) => {
    const userId = String(socket.user._id);
    const hospitalId = socket.user.hospitalId ? String(socket.user.hospitalId) : null;
    const role = socket.user.role;

    socket.join(`user:${userId}`);
    if (hospitalId) {
      socket.join(`hospital:${hospitalId}`);
      socket.join(`hospital:${hospitalId}:role:${role}`);
    }

    logger.info(`Staff connected: user:${userId}, hospital:${hospitalId}, role:${role}`);

    socket.on("disconnect", () => {
      logger.info(`Staff disconnected: user:${userId}`);
    });
  });

  return io;
};

const getIO = () => {
  return io;
};

module.exports = {
  initSocketIO,
  getIO,
};
