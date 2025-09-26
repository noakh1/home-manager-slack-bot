const { App } = require('@slack/bolt');
const chrono = require('chrono-node');
const cron = require('node-cron');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false
});

// Storage
let groceryList = [];
let eventsList = [];
let cleaningTasks = {};
let maintenanceItems = [];
let reminders = [];
let recurringReminders = [];
let pinnedMessages = {
  groceries: null,
  events: null,
  cleaning: null,
  maintenance: null,
  reminders: null
};

let pendingActions = {};

// Helper function to parse relative dates
function parseDateTime(text) {
  const parsed = chrono.parseDate(text);
  if (parsed) {
    return parsed.toISOString();
  }
  return null;
}

// Helper function to parse recurring frequency
function parseRecurringFrequency(text) {
  const lowerText = text.toLowerCase();
  
  // Daily patterns
  if (lowerText.includes('daily') || lowerText.includes('every day')) {
    return { type: 'daily', cron: '0 9 * * *' }; // 9 AM daily
  }
  
  if (lowerText.includes('every morning')) {
    return { type: 'daily', cron: '0 8 * * *' }; // 8 AM daily
  }
  
  if (lowerText.includes('every evening') || lowerText.includes('every night')) {
    return { type: 'daily', cron: '0 20 * * *' }; // 8 PM daily
  }
  
  // Weekly patterns
  if (lowerText.includes('weekly') || lowerText.includes('every week')) {
    return { type: 'weekly', cron: '0 9 * * 1' }; // 9 AM Mondays
  }
  
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < weekdays.length; i++) {
    if (lowerText.includes(`every ${weekdays[i]}`)) {
      return { type: 'weekly', cron: `0 9 * * ${i}` }; // 9 AM on that day
    }
  }
  
  // Monthly patterns
  if (lowerText.includes('monthly') || lowerText.includes('every month')) {
    return { type: 'monthly', cron: '0 9 1 * *' }; // 9 AM 1st of month
  }
  
  // Custom intervals
  const monthMatch = lowerText.match(/every (\d+) months?/);
  if (monthMatch) {
    const months = parseInt(monthMatch[1]);
    return { type: 'custom', interval: months, unit: 'months', cron: '0 9 1 * *' };
  }
  
  const dayMatch = lowerText.match(/every (\d+) days?/);
  if (dayMatch) {
    const days = parseInt(dayMatch[1]);
    return { type: 'custom', interval: days, unit: 'days', cron: '0 9 * * *' };
  }
  
  const weekMatch = lowerText.match(/every (\d+) weeks?/);
  if (weekMatch) {
    const weeks = parseInt(weekMatch[1]);
    return { type: 'custom', interval: weeks, unit: 'weeks', cron: '0 9 * * 1' };
  }
  
  return null;
}

// Helper function to format reminders list
function formatRemindersList() {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "⏰ Active Reminders" }
    }
  ];

  // One-time reminders
  const activeReminders = reminders.filter(r => new Date(r.dueDate) > new Date());
  const overdueReminders = reminders.filter(r => new Date(r.dueDate) <= new Date() && !r.completed);

  if (overdueReminders.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*🔴 Overdue:*" }
    });
    
    const overdueText = overdueReminders.map((reminder, i) => 
      `${i + 1}. **${reminder.message}** _(due ${new Date(reminder.dueDate).toLocaleString()})_\n   👤 For: ${reminder.targetUser || 'Everyone'}`
    ).join('\n\n');
    
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: overdueText }
    });
  }

  if (activeReminders.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*📅 Upcoming:*" }
    });
    
    const upcomingText = activeReminders.map((reminder, i) => 
      `${i + 1}. **${reminder.message}** _(${new Date(reminder.dueDate).toLocaleString()})_\n   👤 For: ${reminder.targetUser || 'Everyone'}`
    ).join('\n\n');
    
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: upcomingText }
    });
  }

  // Recurring reminders
  if (recurringReminders.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*🔄 Recurring Reminders:*" }
    });
    
    const recurringText = recurringReminders.map((reminder, i) => 
      `${i + 1}. **${reminder.message}** _(${reminder.frequency.type})_\n   👤 For: ${reminder.targetUser || 'Everyone'}`
    ).join('\n\n');
    
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: recurringText }
    });
  }

  if (activeReminders.length === 0 && overdueReminders.length === 0 && recurringReminders.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No active reminders! 😊_" }
    });
  }

  blocks.push({
    type: "context",
    elements: [{ 
      type: "mrkdwn", 
      text: "💡 Commands:\n• `remind me: take out trash tomorrow at 7pm`\n• `remind Sam: doctor appointment next Friday`\n• `recurring: charge Ring battery every 3 months`\n• `daily: Sam wash your face every morning`" 
    }]
  });

  return { blocks };
}

async function updateRemindersList(channelId, client) {
  try {
    const content = formatRemindersList();
    const oldMessageTs = pinnedMessages.reminders;
    
    if (oldMessageTs) {
      await client.chat.update({
        channel: channelId,
        ts: oldMessageTs,
        ...content
      });
    } else {
      const result = await client.chat.postMessage({
        channel: channelId,
        ...content
      });
      
      pinnedMessages.reminders = result.ts;
      
      await client.pins.add({
        channel: channelId,
        timestamp: result.ts
      });
    }
  } catch (error) {
    console.error('Error updating reminders list:', error);
  }
}

// Function to send reminder with completion button
async function sendReminder(reminder, client, channelId) {
  const targetText = reminder.targetUser ? `<@${reminder.targetUser}>` : '@here';
  
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⏰ **Reminder for ${targetText}:**\n${reminder.message}`
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "✅ Mark Complete",
            emoji: true
          },
          style: "primary",
          value: reminder.id,
          action_id: "complete_reminder"
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "⏰ Snooze 1hr",
            emoji: true
          },
          value: reminder.id,
          action_id: "snooze_reminder"
        }
      ]
    }
  ];

  await client.chat.postMessage({
    channel: channelId,
    blo
