// index.js

// 1. Load our secret keys from the .env file
require('dotenv').config();

// 2. Import the necessary libraries
const { Telegraf, Markup } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mongoose = require('mongoose');
const http = require('http');

// 3. Initialize the Bot and AI
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- Safety Settings ---
const safetySettings = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

// --- Base System Prompt (Personality) ---
const baseSystemPrompt = `
  You are a world-class, strict, and disciplined mentor for a 3rd-year 
  computer science student. Your goal is to help them land a top tech job. 
  Be direct, ask hard questions, and do not accept excuses.
`;

// --- Database Schemas ---
const GoalSchema = new mongoose.Schema({
  telegramId: { type: String, required: true },
  description: { type: String, required: true },
  isCompleted: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});
const Goal = mongoose.model('Goal', GoalSchema);

const ChatHistorySchema = new mongoose.Schema({
  telegramId: { type: String, required: true },
  role: { type: String, required: true }, // "user" or "model"
  parts: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
});
const ChatHistory = mongoose.model('ChatHistory', ChatHistorySchema);

// --- Database Connection ---
mongoose.connect(process.env.MONGO_DB_URI)
  .then(() => console.log('MongoDB connected successfully.'))
  .catch((err) => console.error('MongoDB connection error:', err));


// 4. Handle the /start command
bot.start(async (ctx) => {
  ctx.reply('Coach is booting up...');
  const telegramId = ctx.message.from.id.toString();

  const goals = await Goal.find({ telegramId: telegramId, isCompleted: false });
  
  // --- NEW PROMPT LOGIC ---
  let goalContext = "";
  if (goals.length > 0) {
    goalContext += "\nThey have these outstanding goals:\n";
    goals.forEach(goal => { goalContext += `- ${goal.description}\n`; });
    goalContext += "Ask them for a progress update on these goals before asking for new ones.";
  } else {
    goalContext += "\nThey have no active goals. Introduce yourself and ask them what their #1 goal is for this week.";
  }

  // Combine personality + context into one system instruction
  const systemInstruction = `${baseSystemPrompt}\n\nCONTEXT: ${goalContext}`;
  
  try {
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-pro", 
      safetySettings,
      systemInstruction // --- NEW: Using the correct field ---
    });
    
    // We just ask it to introduce itself, it will use the system prompt automatically
    const result = await model.generateContent("Introduce yourself and greet the user.");
    const response = await result.response;
    const text = response.text();

    ctx.reply(text);
  } catch (error) {
    console.error("Error on /start:", error);
    ctx.reply("Sorry, I'm having trouble booting up my AI brain.");
  }
});

// --- Command to set a new goal ---
bot.command('setgoal', async (ctx) => {
  const goalDescription = ctx.message.text.replace('/setgoal', '').trim();
  const telegramId = ctx.message.from.id.toString();

  if (!goalDescription) {
    return ctx.reply("You must provide a goal. Example: \n`/setgoal Finish my React project`");
  }

  try {
    const newGoal = new Goal({ telegramId, description: goalDescription });
    await newGoal.save();
    ctx.reply(`New Goal Set:\n"${goalDescription}"\n\nI will hold you accountable for this.`);
    console.log(`New goal saved for user ${telegramId}`);
  } catch (error) {
    console.error("Error saving goal:", error);
    ctx.reply("Sorry, I had trouble saving that goal to my memory.");
  }
});

// --- Command to list active goals ---
bot.command('mygoals', async (ctx) => {
  const telegramId = ctx.message.from.id.toString();
  const goals = await Goal.find({ telegramId, isCompleted: false });

  if (goals.length === 0) {
    return ctx.reply("You have no active goals. Use `/setgoal <your goal>` to create one.");
  }

  let message = "Your Active Goals:\n";
  goals.forEach((goal, index) => {
    message += `${index + 1}. ${goal.description} \n(ID: \`${goal._id}\`)\n`;
  });
  message += "\nUse `/complete <ID>` to mark one as done.";
  
  ctx.replyWithMarkdown(message); 
});

// --- Command to complete a goal ---
bot.command('complete', async (ctx) => {
  const goalId = ctx.message.text.replace('/complete', '').trim();
  const telegramId = ctx.message.from.id.toString();

  if (!goalId) {
    return ctx.reply("You must provide the Goal ID. Use `/mygoals` to see the IDs.");
  }

  try {
    const goal = await Goal.findOneAndUpdate(
      { _id: goalId, telegramId },
      { isCompleted: true },
      { new: true }
    );
    if (!goal) return ctx.reply("I couldn't find a goal with that ID.");
    ctx.reply(`Goal Completed:\n"${goal.description}"\n\nGood. What's next?`);
  } catch (error) {
    console.error("Error completing goal:", error);
    ctx.reply("That doesn't look like a valid ID.");
  }
});

bot.command('week', async (ctx) => {
  const telegramId = ctx.message.from.id.toString();
  await ctx.reply('Analyzing your progress for the last 7 days...');

  try {
    // 1. Get the date for 7 days ago
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    // 2. Find goals completed in the last 7 days
    const completedGoals = await Goal.find({
      telegramId: telegramId,
      isCompleted: true,
      createdAt: { $gte: oneWeekAgo } // 'createdAt' is the key
    });

    // 3. Find all currently active goals
    const activeGoals = await Goal.find({
      telegramId: telegramId,
      isCompleted: false
    });

    // 4. Build the report for the AI
    let report = "Here is my student's weekly report:\n\n";
    report += `COMPLETED GOALS (Last 7 Days): ${completedGoals.length}\n`;
    if (completedGoals.length > 0) {
      completedGoals.forEach(goal => {
        report += `- ${goal.description}\n`;
      });
    }

    report += `\nACTIVE GOALS (Outstanding): ${activeGoals.length}\n`;
    if (activeGoals.length > 0) {
      activeGoals.forEach(goal => {
        report += `- ${goal.description}\n`;
      });
    }

    // 5. Send the report to Gemini for analysis
    const systemInstruction = `
      ${baseSystemPrompt}
      You are now in "Weekly Review" mode. 
      Analyze the following progress report for your student.
      Give them a strict, no-excuses analysis of their performance.
      - If they did well, be firm but acknowledge the progress.
      - If they did poorly, be direct about their lack of focus.
      Conclude by telling them what their #1 priority should be for the week ahead.
    `;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      safetySettings,
      systemInstruction
    });

    // We don't need chat history for this one-off report
    const result = await model.generateContent(report);
    const aiAnalysis = result.response.text();

    if (!aiAnalysis) {
      return ctx.reply("I had trouble analyzing your report. Looks like I'm off my game.");
    }

    ctx.reply(aiAnalysis);

  } catch (error) {
    console.error("Error in /week command:", error);
    ctx.reply("Sorry, I had trouble generating your weekly report.");
  }
});


// 5. Handle *any* text message (FINAL UPGRADED LOGIC)
bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  const telegramId = ctx.message.from.id.toString();
  
  await ctx.reply('Thinking...');

  try {
    // 1. Save user message to DB
    await ChatHistory.create({
      telegramId: telegramId,
      role: 'user',
      parts: userMessage,
    });

    // 2. Fetch context (History & Goals)
    const historyDocs = await ChatHistory.find({ telegramId }).sort({ timestamp: -1 }).limit(10);
    const chatHistory = historyDocs.reverse().map(doc => ({
      role: doc.role,
      parts: [{ text: doc.parts }],
    }));

    while (chatHistory.length > 0 && chatHistory[0].role !== 'user') {
      console.log("Cleaning corrupted history: removing leading 'model' message.");
      chatHistory.shift(); // .shift() removes the first element
    }

    const goals = await Goal.find({ telegramId, isCompleted: false });
    let goalContext = "User has no active goals. Ask them to set one with /setgoal.";
    if (goals.length > 0) {
      goalContext = "User's active goals:\n";
      goals.forEach(goal => { goalContext += `- ${goal.description}\n`; });
      goalContext += "Analyze their message in this context. Be strict.";
    }

    // 3. Combine personality + context into ONE system instruction
    const systemInstruction = `${baseSystemPrompt}\n\nGOAL CONTEXT: ${goalContext}`;

    // 4. Initialize the model and chat session
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      safetySettings,
      systemInstruction // --- THE CLEAN FIX ---
    });
    
    const chat = model.startChat({
      history: chatHistory, // Load the chat history
    });

    // 5. Send ONLY the new user message
    const result = await chat.sendMessage(userMessage);
    const response = await result.response;
    const aiReply = response.text();

    // 6. Check for empty reply
    if (!aiReply || aiReply.trim() === "") {
      console.error("AI returned an empty response.");
      return ctx.reply("My apologies, I seem to have lost my train of thought. Could you rephrase that?");
    }

    // 7. Save AI reply to DB
    await ChatHistory.create({
      telegramId: telegramId,
      role: 'model',
      parts: aiReply,
    });

    // 8. Send to user
    ctx.reply(aiReply);

  } catch (error) {
    // This will catch errors like the 503 Service Unavailable
    console.error("Error processing text:", error);
    ctx.reply("Sorry, I'm having trouble thinking right now. It might be a temporary issue. Please try again in a moment.");
  }
});

// 6. Launch the bot
bot.launch();

const PORT = process.env.PORT || 10000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write('Coach bot is alive and listening!');
  res.end();
}).listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`);
});

console.log('AI Coach Bot is running... (Version 4: Cleaner Prompts)');