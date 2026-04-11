// src/utils/scheduler.js
// Cron-based email polling and processing scheduler

const cron = require('node-cron');
const processorService = require('../services/processorService');
const { runAgentCycle } = require('../services/autonomousAgent');
const cleanupService = require('../services/cleanupService');
const logger = require('../config/logger');

let isProcessing = false;  // Prevent overlapping runs

class Scheduler {
  constructor() {
    this.jobs = [];
    this.pollInterval = process.env.EMAIL_POLL_INTERVAL || '*/5 * * * *';  // Every 5 min
    this.cleanupInterval = '0 2 * * *';  // Daily at 2am
  }

  start() {
    logger.info('Starting email processing scheduler...');

    // Main email polling job
    const emailJob = cron.schedule(
      this.pollInterval,
      async () => {
        if (isProcessing) {
          logger.debug('Previous email processing still running, skipping this cycle');
          return;
        }

        isProcessing = true;
        logger.info('⏰ Scheduled email check starting...');

        try {
          // Use autonomous agent (rule-based, no OpenAI)
          const result = await runAgentCycle();
          logger.info('⏰ Agent cycle complete', result);
        } catch (err) {
          logger.error('Scheduled email processing error', { error: err.message });
        } finally {
          isProcessing = false;
        }
      },
      { scheduled: true, timezone: 'UTC' }
    );

    // Daily inbox cleanup job
    const cleanupJob = cron.schedule(
      this.cleanupInterval,
      async () => {
        logger.info('🧹 Running scheduled inbox cleanup...');
        try {
          const result = await cleanupService.runBulkCleanup(100);
          logger.info('🧹 Scheduled cleanup complete', result);
        } catch (err) {
          logger.error('Scheduled cleanup error', { error: err.message });
        }
      },
      { scheduled: true, timezone: 'UTC' }
    );

    this.jobs.push(emailJob, cleanupJob);
    logger.info(`✅ Scheduler started (email poll: ${this.pollInterval}, cleanup: ${this.cleanupInterval})`);
  }

  stop() {
    this.jobs.forEach((job) => job.stop());
    this.jobs = [];
    logger.info('Scheduler stopped');
  }

  getStatus() {
    return {
      running: this.jobs.length > 0,
      pollInterval: this.pollInterval,
      cleanupInterval: this.cleanupInterval,
      isCurrentlyProcessing: isProcessing,
    };
  }
}

module.exports = new Scheduler();
