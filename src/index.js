require('dotenv').config();

const path = require('path');
const app = require('./app');
const scheduler = require('./utils/scheduler');
const { connectDB } = require('./config/database');
const logger = require('./config/logger');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

async function bootstrap() {
  try {
    await connectDB();
  } catch (err) {
    logger.error('Database connection failed', { error: err.message, stack: err.stack });
    process.exit(1);
  }

  scheduler.start();

  app.listen(PORT, HOST, () => {
    const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
    logger.info('?? Server running at http://' + displayHost + ':' + PORT);
    logger.info('?? Dashboard: http://' + displayHost + ':' + PORT);
    logger.info('?? OAuth: http://' + displayHost + ':' + PORT + '/auth/gmail');
    logger.info('??  Health: http://' + displayHost + ':' + PORT + '/api/health');
  });
}

bootstrap().catch((err) => {
  logger.error('Startup failed', { error: err.message, stack: err.stack });
  process.exit(1);
});