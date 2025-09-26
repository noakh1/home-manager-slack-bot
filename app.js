const { App } = require('@slack/bolt');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false
});
app.event('url_verification', async ({ body, ack }) => {
  await ack(body.challenge);
});

// Storage
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

app.message(async ({ message, say, client }) => {
  const text = message.text?.toLowerCase() || '';
  const channelInfo = await client.conversations.info({ channel: message.channel });
  const channelName = channelInfo.channel.name;
  const userInfo = await client.users.info({ user: message.user });
  const userName = userInfo.user.real_name || userInfo.user.name;

  // GROCERIES
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

  // Add other channel handlers here...
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Home Manager Bot is running!');
})();
