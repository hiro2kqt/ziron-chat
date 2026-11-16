/**
 * Email Mongoose Model
 * Stores classified emails for querying
 */

import mongoose from 'mongoose';

const emailSchema = new mongoose.Schema({
  uid: {
    type: Number,
    required: true,
  },
  mailbox: {
    type: String,
    required: true,
    default: 'INBOX',
  },
  subject: {
    type: String,
    required: true,
  },
  from: {
    type: String,
    required: true,
  },
  date: {
    type: Date,
    required: true,
  },
  snippet: {
    type: String,
    default: '',
  },
  important: {
    type: Boolean,
    required: true,
    default: false,
  },
  category: {
    type: String,
    enum: ['registration', 'exam', 'assignment', 'deadline', 'course', 'announcement', 'other'],
    default: 'other',
  },
  // One-sentence English summary for notifications
  summary: {
    type: String,
    default: '',
  },
  // When Hiro must act ("YYYY-MM-DD" or "YYYY-MM-DDTHH:MM", local time), if any
  deadline: {
    type: String,
    default: null,
  },
  // Why the classifier marked it (not) important
  reason: {
    type: String,
    default: '',
  },
}, {
  timestamps: true, // Auto-manages createdAt and updatedAt
});

// Compound index for efficient queries
emailSchema.index({ mailbox: 1, uid: 1 }, { unique: true });
emailSchema.index({ date: -1 }); // For date range queries
emailSchema.index({ important: 1, date: -1 }); // For important email queries
emailSchema.index({ category: 1, date: -1 }); // For category queries

const Email = mongoose.model('Email', emailSchema);

export default Email;
