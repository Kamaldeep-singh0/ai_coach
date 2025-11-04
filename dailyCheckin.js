// dailyCheckin.js
// This script is run by GitHub Actions, NOT by Render.

require('dotenv').config();
const { Telegraf } = require('telegraf');
const { GoogleGenerAI } = require('@google/generative-ai');
const mongoose = require('mongoose');

// --- Get Secrets from GitHub Actions ---
const MONGO_DB_URI = process.env.MONGO_DB_URI;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MY_TELEGRAM_ID = process.env.MY_TELEGRAM_ID; // Your personal chat ID

// --- Check for Secrets ---
if (!MONGO_DB_URI || !GEMINI_API_KEY || !TELEGRAM_BOT_TOKEN || !MY_TELEGRAM_ID) {
  console.error("Missing one or more environment variables!");
  process.exit(1); // Exit with an error
}

// --- DB Schemas (simplified, we only need to read) ---
const GoalSchema = new mongoose.Schema({
  telegramId: String,
  description: String,
  isCompleted: Boolean,
});
const Goal = mongoose.model('Goal', GoalSchema);

// --- AI Setup ---
const genAI = new GoogleGenerAI(GEMINI_API_KEY);
const safetySettings = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite-001", safetySettings });

// --- Bot Setup ---
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);


// --- The Main Function ---
async function runDailyCheckin() {
  console.log("Connecting to MongoDB...");
  await mongoose.connect(MONGO_DB_URI);
  console.log("MongoDB connected.");

  // 1. Find all goals for your user ID
  const goals = await Goal.find({ telegramId: MY_TELEGRAM_ID, isCompleted: false });

  let goalContext = "The user has no active goals. Tell them to set one today using /setgoal.";
  if (goals.length > 0) {
    goalContext = "The user has these active goals:\n";
    goals.forEach(goal => { goalContext += `- ${goal.description}\n`; });
    goalContext += "Be strict. Ask them for their progress. Do not accept excuses.";
  }

  // 2. Generate the AI message
  console.log("Generating check-in message from AI...");
  const prompt = `
    You are a strict CSE mentor. It's 9 AM. 
    Write a direct, no-excuses daily check-in message for your student.
    ${goalContext}
  `;
  const result = await model.generateContent(prompt);
  const aiMessage = result.response.text();

  if (!aiMessage) {
    throw new Error("AI returned an empty message.");
  }

  // 3. Send the message via Telegram
  console.log("Sending message to user:", MY_TELEGRAM_ID);
  await bot.telegram.sendMessage(MY_TELEGRAM_ID, aiMessage);
  
  console.log("Check-in complete. Exiting.");
  await mongoose.disconnect();
  process.exit(0); // Exit successfully
}

// --- Run the script and handle errors ---
runDailyCheckin().catch(err => {
  console.error("An error occurred:", err);
  // Try to send an error message to yourself
  bot.telegram.sendMessage(MY_TELEGRAM_ID, `Coach Error: ${err.message}`).finally(() => {
    process.exit(1);
  });
});