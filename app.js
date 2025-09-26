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
async funct
