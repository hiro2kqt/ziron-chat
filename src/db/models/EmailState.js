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
    unique: true, // This already creates an index
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

const EmailState = mongoose.model('EmailState', emailStateSchema);

export default EmailState;
