// src/index.js
// Application entry point - starts server, DB, and scheduler

require('dotenv').config();
const app = require('./app');
const { connectDB } = require('./config/database');
const scheduler = require('./utils/scheduler');
const logger = require('./config/logger');

const PORT = parseInt(process.env.PORT) || 3000;

async function bootstrap() {
  logger.info('🚀 Starting AI Email Agent...');
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);

  // Connect to database
  const dbConnected = await connectDB();
  if (!dbConnected) {
    logger.warn('⚠️  Database not connected. Run migrations first: node src/models/migrate.js');
    logger.warn('⚠️  Continuing without database (some features disabled)');
  }

  // Start HTTP server
  const server = app.listen(PORT, () => {
    logger.info(`✅ Server running at http://localhost:${PORT}`);
    logger.info(`📊 Dashboard: http://localhost:${PORT}`);
    logger.info(`🔗 API: http://localhost:${PORT}/api`);
    logger.info(`🔐 OAuth: http://localhost:${PORT}/auth/gmail`);
    logger.info(`❤️  Health: http://localhost:${PORT}/api/health`);
  });

  // Start email polling scheduler (only if DB is connected)
  if (dbConnected) {
    scheduler.start();
  }

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`${signal} received - shutting down gracefully...`);
    scheduler.stop();
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);  // Force kill after 10s
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: String(reason) });
  });
}

bootstrap();