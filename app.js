const { App } = require('@slack/bolt');

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

// Store pinned message timestamps for each channel
let pinnedMessages = {
  groceries: null,
  events: null,
  cleaning: null,
  maintenance: null
};

// Helper function to format grocery list
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

// Helper function to update or create pinned grocery list
async function updateGroceryList(channelId, client) {
  try {
    const content = formatGroceryList();
    const oldMessageTs = pinnedMessages.groceries;
    
    if (oldMessageTs) {
      // Update existing pinned message
      await client.chat.update({
        channel: channelId,
        ts: oldMessageTs,
        ...content
      });
      console.log('Updated existing grocery list message');
    } else {
      // Create new message and pin it
      const result = await client.chat.postMessage({
        channel: channelId,
        ...content
      });
      
      // Save the timestamp and pin the message
      pinnedMessages.groceries = result.ts;
      
      await client.pins.add({
        channel: channelId,
        timestamp: result.ts
      });
      
      console.log('Created and pinned new grocery list message');
    }
  } catch (error) {
    console.error('Error updating grocery list:', error);
  }
}

// Listen for messages
app.message(async ({ message, say, client }) => {
  // Skip bot messages
  if (message.subtype === 'bot_message') return;
  
  const text = message.text?.toLowerCase() || '';
  
  // Get channel and user info
  const channelInfo = await client.conversations.info({ channel: message.channel });
  const channelName = channelInfo.channel.name;
  const userInfo = await client.users.info({ user: message.user });
  const userName = userInfo.user.real_name || userInfo.user.name;

  console.log(`Message in #${channelName}: "${text}" by ${userName}`);

  // GROCERIES CHANNEL
  if (channelName === 'groceries') {
    let listChanged = false;
    
    // Handle "buy:" command
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
          listChanged = true;
        }
      });

      if (addedItems.length > 0) {
        await updateGroceryList(message.channel, client);
        await say(`✅ Added to list: ${addedItems.join(', ')}`);
      } else {
        await say(`ℹ️ Items already on the list: ${items.join(', ')}`);
      }
    }

    // Handle "got:" or "i got:" command
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
          listChanged = true;
        }
      });

      if (removedItems.length > 0) {
        await updateGroceryList(message.channel, client);
        await say(`✅ Removed from list: ${removedItems.join(', ')}`);
      } else {
        await say(`ℹ️ Items not found on list: ${items.join(', ')}`);
      }
    }

    // Handle "list" command to show current list
    if (text === 'list' || text === 'show list') {
      await updateGroceryList(message.channel, client);
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

      await say(`📋 Added to maintenance: ${taskText}`);
    }
  }
});

// Test command
app.message('hello', async ({ say }) => {
  await say('Hello! I\'m your home manager bot. Try `buy: milk, eggs` in #groceries!');
});

// Start the app
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Home Manager Bot is running on port ${port}!`);
})();
