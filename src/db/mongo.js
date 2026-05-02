/**
 * MongoDB Connection
 * Used for email monitoring state
 */

import mongoose from 'mongoose';
import logger from '../utils/logger.js';

let isConnected = false;

/**
 * Connect to MongoDB
 * @param {string} mongoUri - MongoDB connection string
 * @returns {Promise<void>}
 */
export async function connectMongo(mongoUri) {
  if (isConnected) {
    logger.debug('[MongoDB] Already connected');
    return;
  }

  if (!mongoUri) {
    throw new Error('MongoDB URI is required in config.database.mongoUri');
  }

  try {
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });

    isConnected = true;
    logger.success('[MongoDB] Connected successfully');

    // Handle connection events
    mongoose.connection.on('disconnected', () => {
      logger.warn('[MongoDB] Disconnected');
      isConnected = false;
    });

    mongoose.connection.on('error', (err) => {
      logger.error('[MongoDB] Connection error:', err.message);
    });

  } catch (err) {
    logger.error('[MongoDB] Failed to connect:', err.message);
    throw err;
  }
}

/**
 * Disconnect from MongoDB
 * @returns {Promise<void>}
 */
export async function disconnectMongo() {
  if (!isConnected) {
    return;
  }

  try {
    await mongoose.disconnect();
    isConnected = false;
    logger.info('[MongoDB] Disconnected');
  } catch (err) {
    logger.error('[MongoDB] Failed to disconnect:', err.message);
    throw err;
  }
}

/**
 * Check if MongoDB is connected
 * @returns {boolean}
 */
export function isMongoConnected() {
  return isConnected;
}

export default {
  connectMongo,
  disconnectMongo,
  isMongoConnected,
};
