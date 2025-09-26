const { App } = require('@slack/bolt');
const chrono = require('chrono-node');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false
});

// Storage (same as before)
let groceryList = [];
let eventsList = [];
let cleaningTasks = {};
let maintenanceItems = [];
let pinnedMessages = {
  groceries: null,
  events: null,
  cleaning: null,
  maintenance: null
};

let pendingActions = {};

function parseDateTime(text) {
  const parsed = chrono.parseDate(text);
  if (parsed) {
    return parsed.toISOString();
  }
  return null;
}

// Generate Google Calendar link
function generateCalendarLink(eventName, dateTime, description = '') {
  const startDate = new Date(dateTime);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // 1 hour duration
  
  // Format dates for Google Calendar (YYYYMMDDTHHMMSSZ)
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
    ctz: 'America/New_York' // Change to your timezone
  });
  
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// Generate other calendar links
function generateCalendarLinks(eventName, dateTime, description = '') {
  const startDate = new Date(dateTime);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  
  const googleLink = generateCalendarLink(eventName, dateTime, description);
  
  // Outlook link
  const outlookParams = new URLSearchParams({
    subject: eventName,
    startdt: startDate.toISOString(),
    enddt: endDate.toISOString(),
    body: description || 'Added via Slack Home Manager Bot'
  });
  const outlookLink = `https://outlook.live.com/calendar/0/deeplink/compose?${outlookParams.toString()}`;
  
  // Yahoo link
  const yahooParams = new URLSearchParams({
    v: '60',
    title: eventName,
    st: Math.floor(startDate.getTime() / 1000),
    dur: '0100', // 1 hour
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

function createConfirmationMessage(action, details, actionId) {
  let text = '';
  let emoji = '';
  
  switch (action) {
    case 'add':
      const calendarLinks = generateCalendarLinks(details.name, details.dateTime);
      text = `Add event "${details.name}" on ${new Date(details.dateTime).toLocaleString()}?\n\n📅 Quick add to calendar:\n• <${calendarLinks.googleLink}|Google Calendar>\n• <${calendarLinks.outlookLink}|Outlook>\n• <${calendarLinks.yahooLink}|Yahoo Calendar>`;
      emoji = '📅';
      break;
    case 'remove':
      text = `Remove event "${details.name}"?`;
      emoji = '🗑️';
      break;
    case 'update':
      const updateCalendarLinks = generateCalendarLinks(details.newName, details.dateTime);
      text = `Update "${details.oldName}" to "${details.newName}" on ${new Date(details.dateTime).toLocaleString()}?\n\n📅 Quick add updated event:\n• <${updateCalendarLinks.googleLink}|Google Calendar>\n• <${updateCalendarLinks.outlookLink}|Outlook>\n• <${updateCalendarLinks.yahooLink}|Yahoo Calendar>`;
      emoji = '✏️';
      break;
  }

  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} ${text}`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "✅ Add to Bot List"
            },
            style: "primary",
            value: actionId,
            action_id: "confirm_yes"
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "❌ Cancel"
            },
            style: "danger",
            value: actionId,
            action_id: "confirm_no"
          }
        ]
      }
    ]
  };
}

// Handle button interactions (same as before but simpler)
app.action('confirm_yes', async ({ ack, body, client, say }) => {
  await ack();
  
  const actionId = body.actions[0].value;
  const pendingAction = pendingActions[actionId];
  
  if (!pendingAction) {
    await say('❌ This confirmation has expired. Please try again.');
    return;
  }

  const { action, details, channelId, userName } = pendingAction;

  try {
    switch (action) {
      case 'add':
        eventsList.push(details);
        await updateEventsList(channelId, client);
        await say(`✅ Event added to bot list: ${details.name}\n💡 Use the calendar links above to add to your personal calendar!`);
        break;
        
      case 'remove':
        const eventIndex = eventsList.findIndex(event => 
          event.name.toLowerCase().includes(details.name.toLowerCase())
        );
        
        if (eventIndex !== -1) {
          const event = eventsList[eventIndex];
          eventsList.splice(eventIndex, 1);
          await updateEventsList(channelId, client);
          await say(`✅ Removed event: ${event.name}`);
        }
        break;
        
      case 'update':
        const updateIndex = eventsList.findIndex(event => 
          event.name.toLowerCase().includes(details.oldName.toLowerCase())
        );
        
        if (updateIndex !== -1) {
          const event = eventsList[updateIndex];
          event.name = details.newName;
          event.dateTime = details.dateTime;
          event.addedBy = userName;
          
          await updateEventsList(channelId, client);
          await say(`✅ Updated event: ${details.newName}\n💡 Use the calendar links above to add the updated event!`);
        }
        break;
    }
  } catch (error) {
    await say(`❌ Error processing request: ${error.message}`);
  }

  delete pendingActions[actionId];
  
  try {
    await client.chat.delete({
      channel: body.channel.id,
      ts: body.message.ts
    });
  } catch (error) {
    console.log('Could not delete confirmation message');
  }
});

app.action('confirm_no', async ({ ack, body, client, say }) => {
  await ack();
  
  const actionId = body.actions[0].value;
  delete pendingActions[actionId];
  
  await say('❌ Action cancelled.');
  
  try {
    await client.chat.delete({
      channel: body.channel.id,
      ts: body.message.ts
    });
  } catch (error) {
    console.log('Could not delete confirmation message');
  }
});

// Your existing grocery code (same as before)
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

// Main message handler (same events logic but with calendar links)
app.message(async ({ message, say, client }) => {
  if (message.subtype === 'bot_message') return;
  
  const text = message.text?.toLowerCase() || '';
  const originalText = message.text || '';
  
  const channelInfo = await client.conversations.info({ channel: message.channel });
  const channelName = channelInfo.channel.name;
  const userInfo = await client.users.info({ user: message.user });
  const userName = userInfo.user.real_name || userInfo.user.name;

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

  // EVENTS CHANNEL (with calendar links)
  if (channelName === 'events') {
    if (text.startsWith('event:')) {
      const eventText = originalText.replace(/^event:\s*/i, '').trim();
      const dateTime = parseDateTime(eventText);
      
      if (!dateTime) {
        await say('❌ I couldn\'t understand the date/time. Try: `event: Meeting tomorrow at 2pm`');
        return;
      }

      const actionId = `add_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      pendingActions[actionId] = {
        action: 'add',
        details: {
          name: eventText,
          dateTime: dateTime,
          addedBy: userName,
          addedAt: new Date().toISOString()
        },
        channelId: message.channel,
        userName: userName
      };

      const confirmationMessage = createConfirmationMessage('add', pendingActions[actionId].details, actionId);
      await client.chat.postMessage({
        channel: message.channel,
        ...confirmationMessage
      });
    }

    // Remove and update logic (same as before)
    if (text.startsWith('remove event:')) {
      const eventName = originalText.replace(/^remove event:\s*/i, '').trim();
      const event = eventsList.find(e => 
        e.name.toLowerCase().includes(eventName.toLowerCase())
      );
      
      if (!event) {
        await say(`❌ Event not found: ${eventName}`);
        return;
      }

      const actionId = `remove_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      pendingActions[actionId] = {
        action: 'remove',
        details: { name: event.name },
        channelId: message.channel,
        userName: userName
      };

      const confirmationMessage = createConfirmationMessage('remove', pendingActions[actionId].details, actionId);
      await client.chat.postMessage({
        channel: message.channel,
        ...confirmationMessage
      });
    }

    if (text.includes('update event:') && text.includes('->')) {
      const parts = originalText.split('->');
      if (parts.length === 2) {
        const oldEventName = parts[0].replace(/^update event:\s*/i, '').trim();
        const newEventText = parts[1].trim();
        const newDateTime = parseDateTime(newEventText);
        
        const event = eventsList.find(e => 
          e.name.toLowerCase().includes(oldEventName.toLowerCase())
        );
        
        if (!event) {
          await say(`❌ Event not found: ${oldEventName}`);
          return;
        }
        
        if (!newDateTime) {
          await say('❌ I couldn\'t understand the new date/time.');
          return;
        }

        const actionId = `update_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        pendingActions[actionId] = {
          action: 'update',
          details: {
            oldName: event.name,
            newName: newEventText,
            dateTime: newDateTime
          },
          channelId: message.channel,
          userName: userName
        };

        const confirmationMessage = createConfirmationMessage('update', pendingActions[actionId].details, actionId);
        await client.chat.postMessage({
          channel: message.channel,
          ...confirmationMessage
        });
      }
    }

    if (text === 'events') {
      await updateEventsList(message.channel, client);
    }
  }
});

app.message('hello', async ({ say }) => {
  await say('Hello! I\'m your home manager bot.\n• Try `buy: milk` in #groceries\n• Try `event: meeting tomorrow at 2pm` in #events');
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Home Manager Bot is running on port ${port}!`);
})();
