# Email Monitoring

Automatic email monitoring with AI-powered importance classification for university emails.

## Features

- **IMAP Integration**: Connects to any IMAP server (tested with TU Dortmund unimail)
- **Smart Classification**: Uses Claude AI to classify emails as important/not important
- **Category Detection**: Categorizes emails (deadline, exam, assignment, announcement, other)
- **Persistent State**: Tracks last seen UID using MongoDB to avoid duplicate notifications
- **Configurable Polling**: Set custom polling intervals (default: 2 hours)
- **Telegram Notifications**: Sends formatted notifications to your Telegram chat

## Setup

### 1. MongoDB Configuration

Add MongoDB URI to `config.json`:

```json
{
  "database": {
    "mongoUri": "mongodb://localhost:27017/ziron"
  }
}
```

### 2. Email Configuration

Add email settings to `config.json` under `tools.email`:

```json
{
  "tools": {
    "email": {
      "enabled": true,
      "pollIntervalHours": 2,
      "notifyChatId": "YOUR_TELEGRAM_CHAT_ID",
      "imap": {
        "host": "unimail.tu-dortmund.de",
        "port": 993,
        "user": "your_username",
        "pass": "your_password"
      }
    }
  }
}
```

**Configuration Fields:**

- `enabled` (boolean): Enable/disable email monitoring
- `pollIntervalHours` (number): How often to check for new emails (in hours)
- `notifyChatId` (string): Telegram chat ID to send notifications to
- `imap.host` (string): IMAP server hostname
- `imap.port` (number): IMAP port (usually 993 for SSL)
- `imap.user` (string): IMAP username/email
- `imap.pass` (string): IMAP password

### 3. Get Your Telegram Chat ID

Send a message to your bot, then run:

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.ziron/sessions/session-map.json')).telegram)"
```

Or check the logs when you send a message - the chat ID will be displayed.

## How It Works

### 1. Polling

The monitor checks your email inbox at the configured interval (default: 2 hours). On first run, it starts from UID 0 (beginning of inbox).

### 2. Fetching

For each check, it:
- Connects to IMAP server
- Fetches emails with UID > lastSeenUID
- Parses email subject, sender, and content preview

### 3. Classification

Each email is sent to Claude AI with a prompt asking:
- Is this email important?
- What category does it belong to?
- Why is it important/not important?

**Important categories:**
- `deadline` - Assignment due dates, registration deadlines
- `exam` - Exam schedules, locations, results
- `assignment` - New assignments, clarifications
- `announcement` - Course updates, schedule changes, university events
- `other` - Other important emails

### 4. Notification

If an email is classified as important, a Telegram notification is sent with:
- Subject
- Sender
- Category
- Reason for importance
- Content preview

### 5. State Tracking

After processing, the highest UID seen is saved to MongoDB, so the next check only processes new emails.

## MongoDB Schema

```javascript
{
  mailbox: 'INBOX',        // Mailbox name
  lastSeenUID: 12345,      // Last processed UID
  lastCheckedAt: ISODate,  // Last check timestamp
  createdAt: ISODate,      // Auto-managed
  updatedAt: ISODate       // Auto-managed
}
```

## Testing

### Test IMAP Connection

```bash
# Set credentials in environment
IMAP_HOST=unimail.tu-dortmund.de IMAP_USER=your_user IMAP_PASS=your_pass node src/scripts/imap.js
```

### Test Email Monitor

```javascript
import { checkNewEmails } from './src/tools/providers/email/monitor.js';

const emails = await checkNewEmails({
  host: 'unimail.tu-dortmund.de',
  port: 993,
  user: 'your_user',
  pass: 'your_pass',
});

console.log('Important emails:', emails);
```

### Test Classifier

```javascript
import { classifyEmail } from './src/tools/providers/email/classifier.js';

const result = await classifyEmail({
  subject: 'Reminder: Assignment Due Tomorrow',
  from: 'professor@university.edu',
  snippet: 'This is a reminder that your assignment is due tomorrow at 23:59...',
});

console.log('Classification:', result);
// { important: true, reason: '...', category: 'deadline' }
```

## Manual Trigger

You can also manually trigger email checking by sending a message to your bot:

```
Check my emails
```

The bot will call the `check_emails` tool and respond with any important emails found.

## Troubleshooting

### MongoDB Connection Failed

- Ensure MongoDB is running: `mongod --dbpath /path/to/data`
- Check the URI in config.json
- Verify network connectivity

### IMAP Authentication Failed

- Double-check username and password
- Some email providers require app-specific passwords
- Check if IMAP is enabled in your email settings

### No Emails Detected

- Check `lastSeenUID` in MongoDB - it might be ahead of current emails
- Reset state: Delete the document from MongoDB and restart

### Classification Not Working

- Ensure OpenRouter API key is configured
- Check API quota/limits
- Review logs for classifier errors

## Security Notes

- **Never commit config.json with real credentials to git**
- Add config.json to .gitignore
- Use strong, unique passwords for IMAP
- Consider using OAuth if your email provider supports it
- MongoDB connection should use authentication in production

## Advanced

### Custom Classifier Prompt

Edit `src/tools/providers/email/classifier.js` to customize the classification logic.

### Multiple Mailboxes

Currently monitors only INBOX. To add more mailboxes, call `checkNewEmails(config, 'SENT')` with different mailbox names.

### Different AI Models

Change the model in classifier.js:
```javascript
model: 'anthropic/claude-3-opus' // or any OpenRouter model
```
