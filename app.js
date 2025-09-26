const { App } = require('@slack/bolt');
const chrono = require('chrono-node');
const cron = require('node-cron');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false
});

// TIMEZONE CONFIGURATION - Change this to your timezone
const TIMEZONE = 'Europe/Amsterdam'; // Change to your timezone

// Helper function to format dates in your timezone
function formatDateInTimezone(date, timezone = TIMEZONE) {
  return new Date(date).toLocaleString('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

// Helper function to get current time in your timezone
function getCurrentTimeInTimezone(timezone = TIMEZONE) {
  return new Date().toLocaleString('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

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
let reminderChannelId = null;
let channelIds = {};

// Helper function to parse relative dates with timezone awareness
function parseDateTime(text, timezone = TIMEZONE) {
  // Create a reference date in the user's timezone
  const now = new Date();
  const referenceDate = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  
  const parsed = chrono.parseDate(text, referenceDate);
  if (parsed) {
    return parsed.toISOString();
  }
  return null;
}

function parseRecurringFrequency(text) {
  const lowerText = text.toLowerCase();
  
  if (lowerText.includes('daily') || lowerText.includes('every day')) {
    return { type: 'daily', cron: '0 9 * * *' };
  }
  
  if (lowerText.includes('every morning')) {
    return { type: 'daily', cron: '0 8 * * *' };
  }
  
  if (lowerText.includes('every evening') || lowerText.includes('every night')) {
    return { type: 'daily', cron: '0 20 * * *' };
  }
  
  if (lowerText.includes('weekly') || lowerText.includes('every week')) {
    return { type: 'weekly', cron: '0 9 * * 1' };
  }
  
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < weekdays.length; i++) {
    if (lowerText.includes(`every ${weekdays[i]}`)) {
      return { type: 'weekly', cron: `0 9 * * ${i}` };
    }
  }
  
  if (lowerText.includes('monthly') || lowerText.includes('every month')) {
    return { type: 'monthly', cron: '0 9 1 * *' };
  }
  
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

// Button action handlers (same as before)
app.action('complete_reminder', async ({ ack, body, client, say }) => {
  await ack();
  
  console.log('Complete reminder button clicked', body.actions[0].value);
  
  const reminderId = body.actions[0].value;
  
  let reminder = reminders.find(r => r.id === reminderId);
  let isRecurring = false;
  
  if (!reminder) {
    const recurringMatch = reminderId.match(/^recurring_(.+)_\d+$/);
    if (recurringMatch) {
      const originalId = recurringMatch[1];
      reminder = recurringReminders.find(r => r.id === originalId);
      isRecurring = true;
    }
  }
  
  if (reminder) {
    if (!isRecurring) {
      reminder.completed = true;
      reminder.completedAt = new Date().toISOString();
      reminder.completedBy = body.user.name;
    }
    
    await say(`✅ Reminder completed by <@${body.user.id}>: "${reminder.message}"`);
    
    const channelInfo = await client.conversations.info({ channel: body.channel.id });
    if (channelInfo.channel.name === 'remind-me') {
      await updateRemindersList(body.channel.id, client);
    }
  } else {
    console.log('Reminder not found:', reminderId);
    await say('❌ Reminder not found. It may have already been completed.');
  }
  
  try {
    await client.chat.delete({
      channel: body.channel.id,
      ts: body.message.ts
    });
  } catch (error) {
    console.log('Could not delete reminder message:', error.message);
  }
});

app.action('snooze_reminder', async ({ ack, body, client, say }) => {
  await ack();
  
  console.log('Snooze reminder button clicked', body.actions[0].value);
  
  const reminderId = body.actions[0].value;
  let reminder = reminders.find(r => r.id === reminderId);
  
  if (reminder) {
    const newDueDate = new Date(Date.now() + 60 * 60 * 1000);
    reminder.dueDate = newDueDate.toISOString();
    reminder.sent = false;
    
    await say(`⏰ Reminder snoozed for 1 hour by <@${body.user.id}>: "${reminder.message}"\nWill remind again at ${formatDateInTimezone(newDueDate)}`);
    
    const channelInfo = await client.conversations.info({ channel: body.channel.id });
    if (channelInfo.channel.name === 'remind-me') {
      await updateRemindersList(body.channel.id, client);
    }
  } else {
    console.log('Reminder not found for snoozing:', reminderId);
    await say('❌ Reminder not found. It may have already been completed.');
  }
  
  try {
    await client.chat.delete({
      channel: body.channel.id,
      ts: body.message.ts
    });
  } catch (error) {
    console.log('Could not delete reminder message:', error.message);
  }
});

async function sendReminder(reminder, client, channelId) {
  const targetText = reminder.targetUser ? reminder.targetUser : '@here';
  
  console.log('Sending reminder:', reminder.id, reminder.message);
  
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

  try {
    await client.chat.postMessage({
      channel: channelId,
      blocks: blocks
    });
    console.log('Reminder sent successfully');
  } catch (error) {
    console.error('Error sending reminder:', error);
  }
}

// Updated reminder list formatting with timezone-aware dates
function formatRemindersList() {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "⏰ Active Reminders" }
    }
  ];

  const activeReminders = reminders.filter(r => new Date(r.dueDate) > new Date() && !r.completed);
  const overdueReminders = reminders.filter(r => new Date(r.dueDate) <= new Date() && !r.completed);

  if (overdueReminders.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*🔴 Overdue:*" }
    });
    
    const overdueText = overdueReminders.map((reminder, i) => 
      `${i + 1}. **${reminder.message}** _(due ${formatDateInTimezone(reminder.dueDate)})_\n   👤 For: ${reminder.targetUser || 'Everyone'}`
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
      `${i + 1}. **${reminder.message}** _(${formatDateInTimezone(reminder.dueDate)})_\n   👤 For: ${reminder.targetUser || 'Everyone'}`
    ).join('\n\n');
    
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: upcomingText }
    });
  }

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
      text: `💡 Commands:\n• \`remind me: take out trash tomorrow at 7pm\`\n• \`remind Sam: doctor appointment next Friday\`\n• \`daily: Sam wash your face every morning\`\n• Current time: ${getCurrentTimeInTimezone()}` 
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

// [Include your existing grocery functions - keeping same]
function formatGroceryList() {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "🛒 Grocery List" }
    }
  ];

  if (groceryList.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No items needed! 🎉_" }
    });
  } else {
    const listText = groceryList.map((item, i) => 
      `${i + 1}. **${item.name}** _(added by ${item.addedBy})_`
    ).join('\n');
    
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: listText }
    });
  }

  blocks.push({
    type: "context",
    elements: [{ 
      type: "mrkdwn", 
      text: "💡 Use `buy: item1, item2` to add • Use `got: item1, item2` to remove" 
    }]
  });

  return { blocks };
}

async function updateGroceryList(channelId, client) {
  try {
    const content = formatGroceryList();
    const oldMessageTs = pinnedMessages.groceries;
    
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
      
      pinnedMessages.groceries = result.ts;
      
      await client.pins.add({
        channel: channelId,
        timestamp: result.ts
      });
    }
  } catch (error) {
    console.error('Error updating grocery list:', error);
  }
}

// Updated cron jobs with timezone logging
cron.schedule('* * * * *', async () => {
  if (!reminderChannelId) return;
  
  const now = new Date();
  const dueReminders = reminders.filter(r => 
    new Date(r.dueDate) <= now && 
    !r.completed && 
    !r.sent
  );
  
  if (dueReminders.length > 0) {
    console.log(`[${getCurrentTimeInTimezone()}] Checking reminders: ${dueReminders.length} due now`);
  }
  
  for (const reminder of dueReminders) {
    try {
      await sendReminder(reminder, app.client, reminderChannelId);
      reminder.sent = true;
    } catch (error) {
      console.error('Error sending reminder:', error);
    }
  }
});

cron.schedule('0 * * * *', async () => {
  if (!reminderChannelId) return;
  
  for (const recurring of recurringReminders) {
    const now = new Date();
    const lastSent = recurring.lastSent ? new Date(recurring.lastSent) : new Date(0);
    
    let shouldSend = false;
    
    switch (recurring.frequency.type) {
      case 'daily':
        shouldSend = now.getDate() !== lastSent.getDate() || now.getMonth() !== lastSent.getMonth();
        break;
      case 'weekly':
        shouldSend = (now.getTime() - lastSent.getTime()) >= (7 * 24 * 60 * 60 * 1000);
        break;
      case 'monthly':
        shouldSend = now.getMonth() !== lastSent.getMonth() || now.getFullYear() !== lastSent.getFullYear();
        break;
      case 'custom':
        const interval = recurring.frequency.interval;
        const unit = recurring.frequency.unit;
        let millisecondsInterval;
        
        switch (unit) {
          case 'days':
            millisecondsInterval = interval * 24 * 60 * 60 * 1000;
            break;
          case 'weeks':
            millisecondsInterval = interval * 7 * 24 * 60 * 60 * 1000;
            break;
          case 'months':
            millisecondsInterval = interval * 30 * 24 * 60 * 60 * 1000;
            break;
        }
        
        shouldSend = (now.getTime() - lastSent.getTime()) >= millisecondsInterval;
        break;
    }
    
    if (shouldSend) {
      try {
        const recurringReminderId = `recurring_${recurring.id}_${Date.now()}`;
        await sendReminder({
          id: recurringReminderId,
          message: recurring.message,
          targetUser: recurring.targetUser
        }, app.client, reminderChannelId);
        
        recurring.lastSent = now.toISOString();
        console.log(`[${getCurrentTimeInTimezone()}] Sent recurring reminder:`, recurring.message);
      } catch (error) {
        console.error('Error sending recurring reminder:', error);
      }
    }
  }
});

// Main message handler with timezone-aware date parsing
app.message(async ({ message, say, client }) => {
  if (message.subtype === 'bot_message') return;
  
  const text = message.text?.toLowerCase() || '';
  const originalText = message.text || '';
  
  const channelInfo = await client.conversations.info({ channel: message.channel });
  const channelName = channelInfo.channel.name;
  const userInfo = await client.users.info({ user: message.user });
  const userName = userInfo.user.real_name || userInfo.user.name;

  channelIds[channelName] = message.channel;

  if (channelName === 'remind-me') {
    reminderChannelId = message.channel;
  }

  // GROCERIES CHANNEL
  if (channelName === 'groceries') {
    if (text.startsWith('buy:')) {
      const items = text.replace('buy:', '').split(',').map(s => s.trim()).filter(s => s);
      const addedItems = [];
      
      items.forEach(item => {
        if (!groceryList.find(existing => existing.name.toLowerCase() === item.toLowerCase())) {
          groceryList.push({
            name: item,
            addedBy: userName,
            addedAt: new Date().toISOString()
          });
          addedItems.push(item);
        }
      });

      if (addedItems.length > 0) {
        await updateGroceryList(message.channel, client);
        await say(`✅ Added to list: ${addedItems.join(', ')}`);
      } else {
        await say(`ℹ️ Items already on the list: ${items.join(', ')}`);
      }
    }

    if (text.startsWith('got:') || text.startsWith('i got:')) {
      const items = text.replace(/^(got:|i got:)/, '').split(',').map(s => s.trim()).filter(s => s);
      const removedItems = [];
      
      items.forEach(item => {
        const index = groceryList.findIndex(existing => 
          existing.name.toLowerCase() === item.toLowerCase()
        );
        if (index !== -1) {
          groceryList.splice(index, 1);
          removedItems.push(item);
        }
      });

      if (removedItems.length > 0) {
        await updateGroceryList(message.channel, client);
        await say(`✅ Removed from list: ${removedItems.join(', ')}`);
      } else {
        await say(`ℹ️ Items not found on list: ${items.join(', ')}`);
      }
    }

    if (text === 'list') {
      await updateGroceryList(message.channel, client);
    }
  }

  // REMIND-ME CHANNEL with timezone-aware parsing
  if (channelName === 'remind-me') {
    // Show current time
    if (text === 'time' || text === 'timezone') {
      await say(`🕐 Current time: ${getCurrentTimeInTimezone()}\n🌍 Timezone: ${TIMEZONE}`);
      return;
    }

    // One-time reminders
    if (text.startsWith('remind me:') || text.startsWith('remind:')) {
      const reminderText = originalText.replace(/^remind( me)?:\s*/i, '').trim();
      const dueDate = parseDateTime(reminderText, TIMEZONE);
      
      if (!dueDate) {
        await say('❌ I couldn\'t understand the date/time. Try: `remind me: take out trash tomorrow at 7pm`\nCurrent time: ' + getCurrentTimeInTimezone());
        return;
      }

      const newReminder = {
        id: `reminder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        message: reminderText,
        dueDate: dueDate,
        addedBy: userName,
        addedAt: new Date().toISOString(),
        completed: false,
        sent: false
      };

      reminders.push(newReminder);
      await updateRemindersList(message.channel, client);
      await say(`⏰ Reminder set: "${reminderText}" for ${formatDateInTimezone(dueDate)}`);
    }

    // Reminders for specific people
    if (text.startsWith('remind ') && text.includes(':') && !text.startsWith('remind me:')) {
      const match = originalText.match(/^remind\s+(\w+):\s*(.+)/i);
      if (match) {
        const targetUser = match[1];
        const reminderText = match[2].trim();
        const dueDate = parseDateTime(reminderText, TIMEZONE);
        
        if (!dueDate) {
          await say('❌ I couldn\'t understand the date/time. Try: `remind Sam: doctor appointment next Friday at 2pm`\nCurrent time: ' + getCurrentTimeInTimezone());
          return;
        }

        const newReminder = {
          id: `reminder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          message: reminderText,
          dueDate: dueDate,
          targetUser: targetUser,
          addedBy: userName,
          addedAt: new Date().toISOString(),
          completed: false,
          sent: false
        };

        reminders.push(newReminder);
        await updateRemindersList(message.channel, client);
        await say(`⏰ Reminder set for ${targetUser}: "${reminderText}" for ${formatDateInTimezone(dueDate)}`);
      }
    }

    // Recurring reminders (same logic as before)
    if (text.startsWith('recurring:') || text.startsWith('daily:') || text.startsWith('weekly:') || text.startsWith('monthly:')) {
      let reminderText, frequency;
      
      if (text.startsWith('daily:')) {
        reminderText = originalText.replace(/^daily:\s*/i, '').trim();
        frequency = { type: 'daily', cron: '0 8 * * *' };
      } else if (text.startsWith('weekly:')) {
        reminderText = originalText.replace(/^weekly:\s*/i, '').trim();
        frequency = { type: 'weekly', cron: '0 9 * * 1' };
      } else if (text.startsWith('monthly:')) {
        reminderText = originalText.replace(/^monthly:\s*/i, '').trim();
        frequency = { type: 'monthly', cron: '0 9 1 * *' };
      } else {
        reminderText = originalText.replace(/^recurring:\s*/i, '').trim();
        frequency = parseRecurringFrequency(reminderText);
      }
      
      if (!frequency) {
        await say('❌ I couldn\'t understand the frequency. Try: `recurring: charge Ring battery every 3 months` or `daily: Sam wash your face every morning`');
        return;
      }

      let targetUser = null;
      const userMatch = reminderText.match(/^(\w+)[,:]?\s+(.+)/);
      if (userMatch && !reminderText.toLowerCase().includes('every')) {
        targetUser = userMatch[1];
        reminderText = userMatch[2];
      }

      const newRecurring = {
        id: `recurring_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        message: reminderText,
        frequency: frequency,
        targetUser: targetUser,
        addedBy: userName,
        addedAt: new Date().toISOString(),
        lastSent: null
      };

      recurringReminders.push(newRecurring);
      await updateRemindersList(message.channel, client);
      
      const targetText = targetUser ? ` for ${targetUser}` : '';
      await say(`🔄 Recurring reminder set${targetText}: "${reminderText}" (${frequency.type})`);
    }

    // Remove reminders
    if (text.startsWith('remove reminder:') || text.startsWith('delete reminder:')) {
      const searchText = originalText.replace(/^(remove|delete) reminder:\s*/i, '').trim().toLowerCase();
      
      const reminderIndex = reminders.findIndex(r => 
        r.message.toLowerCase().includes(searchText)
      );
      
      if (reminderIndex !== -1) {
        const removedReminder = reminders.splice(reminderIndex, 1)[0];
        await updateRemindersList(message.channel, client);
        await say(`✅ Removed reminder: "${removedReminder.message}"`);
        return;
      }
      
      const recurringIndex = recurringReminders.findIndex(r => 
        r.message.toLowerCase().includes(searchText)
      );
      
      if (recurringIndex !== -1) {
        const removedRecurring = recurringReminders.splice(recurringIndex, 1)[0];
        await updateRemindersList(message.channel, client);
        await say(`✅ Removed recurring reminder: "${removedRecurring.message}"`);
        return;
      }
      
      await say(`❌ Reminder not found: "${searchText}"`);
    }

    if (text === 'reminders' || text === 'list reminders') {
      await updateRemindersList(message.channel, client);
    }

    // Test reminder
    if (text.startsWith('test reminder:')) {
      const testMessage = originalText.replace(/^test reminder:\s*/i, '').trim();
      
      const testReminder = {
        id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        message: testMessage || 'Test reminder',
        targetUser: null
      };
      
      await sendReminder(testReminder, client, message.channel);
      await say('📧 Test reminder sent! Try clicking the buttons.');
    }
  }
});

app.message('hello', async ({ say, message }) => {
  console.log(`Hello from user: ${message.user}`);
  await say(`Hello! I\'m your home manager bot.\n🕐 Current time: ${getCurrentTimeInTimezone()}\n🌍 Timezone: ${TIMEZONE}\n\n• Try \`buy: milk\` in #groceries\n• Try \`remind me: test in 1 minute\` in #remind-me\n• Try \`time\` to check current time`);
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Home Manager Bot is running on port ${port}!`);
  console.log(`📅 Reminder system active in timezone: ${TIMEZONE}`);
  console.log(`🕐 Current time: ${getCurrentTimeInTimezone()}`);
})();
