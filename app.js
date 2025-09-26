const { App } = require('@slack/bolt');

// Initialize app with bot token
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
  processBeforeResponse: true
});

// In-memory storage
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

// Helper function to format grocery list
function formatGroceryList() {
  if (groceryList.length === 0) {
    return {
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "🛒 Grocery List" }
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: "_No items needed!_" }
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: "Use `buy: item1, item2` to add items • Use `got: item1, item2` to remove items" }]
        }
      ]
    };
  }

  const listText = groceryList.map((item, i) => 
    `${i + 1}. ${item.name} _(added by ${item.addedBy})_`
  ).join('\n');

  return {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🛒 Grocery List" }
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: listText }
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Use `buy: item1, item2` to add items • Use `got: item1, item2` to remove items" }]
      }
    ]
  };
}

// Helper function to update pinned message
async function updatePinnedMessage(channelId, messageType, content) {
  try {
    const oldTs = pinnedMessages[messageType];
    
    if (oldTs) {
      await app.client.chat.update({
        channel: channelId,
        ts: oldTs,
        ...content
      });
    } else {
      const result = await app.client.chat.postMessage({
        channel: channelId,
        ...content
      });
      
      pinnedMessages[messageType] = result.ts;
      
      await app.client.pins.add({
        channel: channelId,
        timestamp: result.ts
      });
    }
  } catch (error) {
    console.error('Error updating pinned message:', error);
  }
}

// Listen for messages in channels
app.message(async ({ message, say, client }) => {
  // Skip if message is from a bot
  if (message.subtype === 'bot_message') return;
  
  const text = message.text?.toLowerCase() || '';
  const channelInfo = await client.conversations.info({ channel: message.channel });
  const channelName = channelInfo.channel.name;
  const userInfo = await client.users.info({ user: message.user });
  const userName = userInfo.user.real_name || userInfo.user.name;

  // GROCERIES CHANNEL
  if (channelName === 'groceries') {
    if (text.startsWith('buy:')) {
      const items = text.replace('buy:', '').split(',').map(s => s.trim()).filter(s => s);
      
      items.forEach(item => {
        if (!groceryList.find(existing => existing.name.toLowerCase() === item.toLowerCase())) {
          groceryList.push({
            name: item,
            addedBy: userName,
            addedAt: new Date().toISOString()
          });
        }
      });

      await updatePinnedMessage(message.channel, 'groceries', formatGroceryList());
      await say(`✅ Added: ${items.join(', ')}`);
    }

    if (text.startsWith('got:') || text.startsWith('i got:')) {
      const items = text.replace(/^(got:|i got:)/, '').split(',').map(s => s.trim()).filter(s => s);
      
      items.forEach(item => {
        groceryList = groceryList.filter(existing => 
          existing.name.toLowerCase() !== item.toLowerCase()
        );
      });

      await updatePinnedMessage(message.channel, 'groceries', formatGroceryList());
      await say(`✅ Removed: ${items.join(', ')}`);
    }
  }

  // EVENTS CHANNEL
  if (channelName === 'events') {
    if (text.startsWith('event:')) {
      const eventText = text.replace('event:', '').trim();
      eventsList.push({
        text: eventText,
        addedBy: userName,
        addedAt: new Date().toISOString()
      });

      const eventsContent = {
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: "📅 Upcoming Events" }
          },
          {
            type: "section",
            text: { 
              type: "mrkdwn", 
              text: eventsList.map((event, i) => 
                `${i + 1}. ${event.text} _(added by ${event.addedBy})_`
              ).join('\n') || "_No events scheduled_"
            }
          },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: "Use `event: description` to add events" }]
          }
        ]
      };

      await updatePinnedMessage(message.channel, 'events', eventsContent);
      await say(`📅 Event added: ${eventText}`);
    }
  }

  // CLEANING CHANNEL
  if (channelName === 'cleaning-schedule') {
    if (text.startsWith('cleaned:')) {
      const tasks = text.replace('cleaned:', '').split(',').map(s => s.trim()).filter(s => s);
      
      tasks.forEach(task => {
        cleaningTasks[task] = {
          lastCleaned: new Date().toISOString(),
          cleanedBy: userName
        };
      });

      const cleaningContent = {
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: "🧹 Cleaning Schedule" }
          },
          {
            type: "section",
            text: { 
              type: "mrkdwn", 
              text: Object.keys(cleaningTasks).map(task => {
                const info = cleaningTasks[task];
                const date = new Date(info.lastCleaned).toLocaleDateString();
                return `• *${task}*: Last cleaned ${date} by ${info.cleanedBy}`;
              }).join('\n') || "_No cleaning logged yet_"
            }
          },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: "Use `cleaned: kitchen, bathroom` to log cleaning" }]
          }
        ]
      };

      await updatePinnedMessage(message.channel, 'cleaning', cleaningContent);
      await say(`🧹 Logged cleaning: ${tasks.join(', ')}`);
    }
  }

  // MAINTENANCE CHANNEL
  if (channelName === 'house-maintenance') {
    if (text.startsWith('done:')) {
      const taskText = text.replace('done:', '').trim();
      maintenanceItems.push({
        task: taskText,
        status: 'completed',
        completedBy: userName,
        completedAt: new Date().toISOString()
      });

      await updateMaintenanceMessage(message.channel);
      await say(`🔧 Completed: ${taskText}`);
    }

    if (text.startsWith('due:')) {
      const taskText = text.replace('due:', '').trim();
      maintenanceItems.push({
        task: taskText,
        status: 'pending',
        addedBy: userName,
        addedAt: new Date().toISOString()
      });

      await updateMaintenanceMessage(message.channel);
      await say(`📋 Added to maintenance: ${taskText}`);
    }
  }
});

async function updateMaintenanceMessage(channelId) {
  const pending = maintenanceItems.filter(item => item.status === 'pending');
  const completed = maintenanceItems.filter(item => item.status === 'completed').slice(-5);

  const maintenanceContent = {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🔧 House Maintenance" }
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Pending Tasks:*" }
      },
      {
        type: "section",
        text: { 
          type: "mrkdwn", 
          text: pending.map((item, i) => 
            `${i + 1}. ${item.task} _(added by ${item.addedBy})_`
          ).join('\n') || "_No pending tasks_"
        }
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Recently Completed:*" }
      },
      {
        type: "section",
        text: { 
          type: "mrkdwn", 
          text: completed.map(item => 
            `• ${item.task} _(completed by ${item.completedBy})_`
          ).join('\n') || "_No completed tasks yet_"
        }
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Use `done: task description` to mark complete • Use `due: task description` to add pending task" }]
      }
    ]
  };

  await updatePinnedMessage(channelId, 'maintenance', maintenanceContent);
}

// Start the app
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Home Manager Bot is running on port ${port}!`);
})();
