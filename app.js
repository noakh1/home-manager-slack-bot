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
    blocks: blocks
  });
}

// Handle reminder completion
app.action('complete_reminder', async ({ ack, body, client, say }) => {
  await ack();
  
  const reminderId = body.actions[0].value;
  const reminder = reminders.find(r => r.id === reminderId);
  
  if (reminder) {
    reminder.completed = true;
    reminder.completedAt = new Date().toISOString();
    reminder.completedBy = body.user.name;
    
    await say(`✅ Reminder completed by <@${body.user.id}>: "${reminder.message}"`);
    
    // Update the reminder list if we're in the reminders channel
    const channelInfo = await client.conversations.info({ channel: body.channel.id });
    if (channelInfo.channel.name === 'remind-me') {
      await updateRemindersList(body.channel.id, client);
    }
  }
  
  // Delete the reminder message
  try {
    await client.chat.delete({
      channel: body.channel.id,
      ts: body.message.ts
    });
  } catch (error) {
    console.log('Could not delete reminder message');
  }
});

// Handle reminder snoozing
app.action('snooze_reminder', async ({ ack, body, client, say }) => {
  await ack();
  
  const reminderId = body.actions[0].value;
  const reminder = reminders.find(r => r.id === reminderId);
  
  if (reminder) {
    // Snooze for 1 hour
    reminder.dueDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    
    await say(`⏰ Reminder snoozed for 1 hour by <@${body.user.id}>: "${reminder.message}"`);
    
    // Update the reminder list if we're in the reminders channel
    const channelInfo = await client.conversations.info({ channel: body.channel.id });
    if (channelInfo.channel.name === 'remind-me') {
      await updateRemindersList(body.channel.id, client);
    }
  }
  
  // Delete the reminder message
  try {
    await client.chat.delete({
      channel: body.channel.id,
      ts: body.message.ts
    });
  } catch (error) {
    console.log('Could not delete reminder message');
  }
});

// Store channel ID for reminders (we need this for the cron job)
let reminderChannelId = null;

// Cron job to check for due reminders
cron.schedule('* * * * *', async () => { // Check every minute
  if (!reminderChannelId) return;
  
  const now = new Date();
  const dueReminders = reminders.filter(r => 
    new Date(r.dueDate) <= now && 
    !r.completed && 
    !r.sent
  );
  
  for (const reminder of dueReminders) {
    try {
      await sendReminder(reminder, app.client, reminderChannelId);
      reminder.sent = true;
    } catch (error) {
      console.error('Error sending reminder:', error);
    }
  }
});

// Cron job for recurring reminders
cron.schedule('0 * * * *', async () => { // Check every hour
  if (!reminderChannelId) return;
  
  for (const recurring of recurringReminders) {
    const now = new Date();
    const lastSent = recurring.lastSent ? new Date(recurring.lastSent) : new Date(0);
    
    let shouldSend = false;
    
    switch (recurring.frequency.type) {
      case 'daily':
        shouldSend = now.getDate() !== lastSent.getDate();
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
            millisecondsInterval = interval * 30 * 24 * 60 * 60 * 1000; // Approximate
            break;
        }
        
        shouldSend = (now.getTime() - lastSent.getTime()) >= millisecondsInterval;
        break;
    }
    
    if (shouldSend) {
      try {
        await sendReminder({
          id: `recurring_${recurring.id}_${Date.now()}`,
          message: recurring.message,
          targetUser: recurring.targetUser
        }, app.client, reminderChannelId);
        
        recurring.lastSent = now.toISOString();
      } catch (error) {
        console.error('Error sending recurring reminder:', error);
      }
    }
  }
});

// Include all your existing code for groceries, events, etc.
// [Previous grocery and events code here - keeping it the same]

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

// Calendar link functions (keeping the same)
function generateCalendarLinks(eventName, dateTime, description = '') {
  const startDate = new Date(dateTime);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  
  const formatDate = (date) => {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };
  
  const startFormatted = formatDate(startDate);
  const endFormatted = formatDate(endDate);
  
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: eventName,
    dates: `${startFormatted}/${endFormatted}`,
    details: description || `Added via Slack Home Manager Bot`,
    ctz: 'America/New_York'
  });
  
  const googleLink = `https://calendar.google.com/calendar/render?${params.toString()}`;
  
  const outlookParams = new URLSearchParams({
    subject: eventName,
    startdt: startDate.toISOString(),
    enddt: endDate.toISOString(),
    body: description || 'Added via Slack Home Manager Bot'
  });
  const outlookLink = `https://outlook.live.com/calendar/0/deeplink/compose?${outlookParams.toString()}`;
  
  const yahooParams = new URLSearchParams({
    v: '60',
    title: eventName,
    st: Math.floor(startDate.getTime() / 1000),
    dur: '0100',
    desc: description || 'Added via Slack Home Manager Bot'
  });
  const yahooLink = `https://calendar.yahoo.com/?${yahooParams.toString()}`;
  
  return { googleLink, outlookLink, yahooLink };
}

function formatEventsList() {
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "📅 Upcoming Events" }
    }
  ];

  if (eventsList.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No events scheduled! 📭_" }
    });
  } else {
    const listText = eventsList.map((event, i) => {
      const date = event.dateTime ? new Date(event.dateTime).toLocaleString() : 'No date set';
      const calendarLinks = event.dateTime ? generateCalendarLinks(event.name, event.dateTime) : null;
      
      let eventText = `${i + 1}. **${event.name}**\n   📅 ${date}\n   👤 _Added by ${event.addedBy}_`;
      
      if (calendarLinks) {
        eventText += `\n   🔗 <${calendarLinks.googleLink}|Add to Google Calendar> | <${calendarLinks.outlookLink}|Outlook> | <${calendarLinks.yahooLink}|Yahoo>`;
      }
      
      return eventText;
    }).join('\n\n');
    
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: listText }
    });
  }

  blocks.push({
    type: "context",
    elements: [{ 
      type: "mrkdwn", 
      text: "💡 Commands:\n• `event: Meeting tomorrow at 2pm`\n• `remove event: Meeting`\n• `update event: Meeting -> Wednesday at 3pm`" 
    }]
  });

  return { blocks };
}

async function updateEventsList(channelId, client) {
  try {
    const content = formatEventsList();
    const oldMessageTs = pinnedMessages.events;
    
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
      
      pinnedMessages.events = result.ts;
      
      await client.pins.add({
        channel: channelId,
        timestamp: result.ts
      });
    }
  } catch (error) {
    console.error('Error updating events list:', error);
  }
}

// Main message handler
app.message(async ({ message, say, client }) => {
  if (message.subtype === 'bot_message') return;
  
  const text = message.text?.toLowerCase() || '';
  const originalText = message.text || '';
  
  const channelInfo = await client.conversations.info({ channel: message.channel });
  const channelName = channelInfo.channel.name;
  const userInfo = await client.users.info({ user: message.user });
  const userName = userInfo.user.real_name || userInfo.user.name;

  // Set reminder channel ID when we're in the remind-me channel
  if (channelName === 'remind-me') {
    reminderChannelId = message.channel;
  }

  // GROCERIES CHANNEL (same as before)
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

  // EVENTS CHANNEL (same as before - keeping the existing events functionality)
  if (channelName === 'events') {
    // [Keep all the existing events code here]
    if (text === 'events') {
      await updateEventsList(message.channel, client);
    }
  }

  // REMIND-ME CHANNEL (new functionality)
  if (channelName === 'remind-me') {
    // One-time reminders
    if (text.startsWith('remind me:') || text.startsWith('remind:')) {
      const reminderText = originalText.replace(/^remind( me)?:\s*/i, '').trim();
      const dueDate = parseDateTime(reminderText);
      
      if (!dueDate) {
        await say('❌ I couldn\'t understand the date/time. Try: `remind me: take out trash tomorrow at 7pm`');
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
      await say(`⏰ Reminder set: "${reminderText}" for ${new Date(dueDate).toLocaleString()}`);
    }

    // Reminders for specific people
    if (text.startsWith('remind ') && text.includes(':') && !text.startsWith('remind me:')) {
      const match = originalText.match(/^remind\s+(\w+):\s*(.+)/i);
      if (match) {
        const targetUser = match[1];
        const reminderText = match[2].trim();
        const dueDate = parseDateTime(reminderText);
        
        if (!dueDate) {
          await say('❌ I couldn\'t understand the date/time. Try: `remind Sam: doctor appointment next Friday at 2pm`');
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
        await say(`⏰ Reminder set for ${targetUser}: "${reminderText}" for ${new Date(dueDate).toLocaleString()}`);
      }
    }

    // Recurring reminders
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

      // Extract target user if mentioned
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
      
      // Try to find and remove one-time reminder
      const reminderIndex = reminders.findIndex(r => 
        r.message.toLowerCase().includes(searchText)
      );
      
      if (reminderIndex !== -1) {
        const removedReminder = reminders.splice(reminderIndex, 1)[0];
        await updateRemindersList(message.channel, client);
        await say(`✅ Removed reminder: "${removedReminder.message}"`);
        return;
      }
      
      // Try to find and remove recurring reminder
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

    // Show reminders
    if (text === 'reminders' || text === 'list reminders') {
      await updateRemindersList(message.channel, client);
    }
  }
});

app.message('hello', async ({ say }) => {
  await say('Hello! I\'m your home manager bot.\n• Try `buy: milk` in #groceries\n• Try `event: meeting tomorrow at 2pm` in #events\n• Try `remind me: take out trash tomorrow at 7pm` in #remind-me');
});

// Start the app
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Home Manager Bot is running on port ${port}!`);
  console.log('📅 Reminder system active - checking every minute for due reminders');
})();
