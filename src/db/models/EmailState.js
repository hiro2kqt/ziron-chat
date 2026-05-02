/**
 * EmailState Mongoose Model
 * Tracks last seen UID for email monitoring
 */

import mongoose from 'mongoose';

const emailStateSchema = new mongoose.Schema({
  mailbox: {
    type: String,
    required: true,
    default: 'INBOX',
    unique: true,
  },
  lastSeenUID: {
    type: Number,
    required: true,
    default: 0,
  },
  lastCheckedAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true, // Auto-manages createdAt and updatedAt
});

// Create index for efficient queries
emailStateSchema.index({ mailbox: 1 });

const EmailState = mongoose.model('EmailState', emailStateSchema);

export default EmailState;
