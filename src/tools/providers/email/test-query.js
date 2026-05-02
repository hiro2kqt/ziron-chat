#!/usr/bin/env node

/**
 * Test script for query_emails functionality
 *
 * Usage:
 *   node src/tools/providers/email/test-query.js
 */

import { connectMongo } from '../../../db/mongo.js';
import { queryEmails, formatQueryResults } from './query.js';
import Email from '../../../db/models/Email.js';
import { loadConfig } from '../../../config/index.js';

async function testQuery() {
  console.log('🧪 Testing query_emails functionality\n');

  // Load config
  const config = loadConfig();
  const mongoUri = config.database?.mongoUri;

  if (!mongoUri) {
    console.error('❌ No MongoDB URI configured in config.json');
    process.exit(1);
  }

  // Connect to MongoDB
  console.log('📡 Connecting to MongoDB...');
  await connectMongo(mongoUri);
  console.log('✓ Connected\n');

  // Check if we have any emails
  const totalEmails = await Email.countDocuments();
  const importantEmails = await Email.countDocuments({ important: true });

  console.log(`📊 Database Stats:`);
  console.log(`   Total emails: ${totalEmails}`);
  console.log(`   Important emails: ${importantEmails}\n`);

  if (totalEmails === 0) {
    console.log('⚠️  No emails in database. Run email monitoring first to populate data.\n');

    // Optionally insert test data
    console.log('Creating test data...');
    await createTestData();
    console.log('✓ Test data created\n');
  }

  // Test 1: Query last 7 days
  console.log('Test 1: Query last 7 days');
  console.log('─'.repeat(50));
  const result1 = await queryEmails({ days: 7 });
  console.log(formatQueryResults(result1));
  console.log();

  // Test 2: Query last 30 days with topic
  console.log('Test 2: Query last 30 days, topic "exam"');
  console.log('─'.repeat(50));
  const result2 = await queryEmails({ days: 30, topic: 'exam' });
  console.log(formatQueryResults(result2));
  console.log();

  // Test 3: Query by category
  console.log('Test 3: Query last 30 days, topic "deadline"');
  console.log('─'.repeat(50));
  const result3 = await queryEmails({ days: 30, topic: 'deadline' });
  console.log(formatQueryResults(result3));
  console.log();

  // Test 4: Explicit date range
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  console.log(`Test 4: Explicit date range (${startDate} to ${endDate})`);
  console.log('─'.repeat(50));
  const result4 = await queryEmails({ startDate, endDate });
  console.log(formatQueryResults(result4));
  console.log();

  console.log('✅ All tests completed');
  process.exit(0);
}

/**
 * Create test data for demonstration
 */
async function createTestData() {
  const now = new Date();

  const testEmails = [
    {
      uid: 1001,
      mailbox: 'INBOX',
      subject: 'Machine Learning Assignment 3 Due Friday',
      from: 'prof.smith@university.edu',
      date: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      snippet: 'This is a reminder that Assignment 3 is due this Friday at 23:59...',
      important: true,
      category: 'deadline',
      summary: 'Assignment 3 deadline reminder',
    },
    {
      uid: 1002,
      mailbox: 'INBOX',
      subject: 'Midterm Exam Schedule Announced',
      from: 'registrar@university.edu',
      date: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
      snippet: 'The midterm examination schedule has been posted. Please check the portal...',
      important: true,
      category: 'exam',
      summary: 'Midterm exam schedule announcement',
    },
    {
      uid: 1003,
      mailbox: 'INBOX',
      subject: 'Guest Lecture: AI Safety Next Week',
      from: 'cs-department@university.edu',
      date: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000), // 1 day ago
      snippet: 'We are pleased to announce a guest lecture on AI Safety by Dr. Johnson...',
      important: true,
      category: 'announcement',
      summary: 'Guest lecture announcement',
    },
    {
      uid: 1004,
      mailbox: 'INBOX',
      subject: 'Project Proposal Deadline Extended',
      from: 'prof.anderson@university.edu',
      date: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
      snippet: 'Due to popular request, the project proposal deadline has been extended to...',
      important: true,
      category: 'deadline',
      summary: 'Deadline extension for project proposal',
    },
    {
      uid: 1005,
      mailbox: 'INBOX',
      subject: 'Final Exam Room Assignments',
      from: 'exam-office@university.edu',
      date: new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000), // 15 days ago
      snippet: 'Your final exam room assignments are now available in the student portal...',
      important: true,
      category: 'exam',
      summary: 'Final exam room assignment notification',
    },
  ];

  for (const email of testEmails) {
    await Email.findOneAndUpdate(
      { mailbox: email.mailbox, uid: email.uid },
      email,
      { upsert: true, new: true }
    );
  }

  console.log(`   Created ${testEmails.length} test emails`);
}

// Run test
testQuery().catch(err => {
  console.error('❌ Test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
