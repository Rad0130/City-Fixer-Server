const express = require('express');
const cors = require('cors');
require('dotenv').config();
const app = express();
const stripe = require('stripe')(process.env.STRIPE_KEY);
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.dm5zycv.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

app.use(cors());
app.use(express.json());

const openRouterClient = axios.create({
  baseURL: 'https://openrouter.ai/api/v1',
  headers: {
    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': process.env.SITE_DOMAIN || 'http://localhost:5173',
    'X-Title': 'CityFix Platform'
  }
});

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Firebase Admin ────────────────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    type: 'service_account',
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  }),
});

// ── Auth Middleware ───────────────────────────────────────────────────────────
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer '))
    return res.status(401).send({ message: 'Unauthorized' });
  try {
    req.user = await admin.auth().verifyIdToken(authHeader.split(' ')[1]);
    next();
  } catch { return res.status(401).send({ message: 'Invalid token' }); }
};

const verifyAdmin = async (req, res, next) => {
  try {
    const u = await client.db('cityFixerDB').collection('users').findOne({ email: req.user.email });
    if (!u || u.role !== 'admin') return res.status(403).send({ message: 'Admin only' });
    next();
  } catch { res.status(500).send({ message: 'Server error' }); }
};

const verifyAdminOrStaff = async (req, res, next) => {
  try {
    const u = await client.db('cityFixerDB').collection('users').findOne({ email: req.user.email });
    if (!u || !['admin', 'staff'].includes(u.role))
      return res.status(403).send({ message: 'Forbidden' });
    next();
  } catch { res.status(500).send({ message: 'Server error' }); }
};

// ── Tracking ID ───────────────────────────────────────────────────────────────
const getNextTrackingId = async (db) => {
  const r = await db.collection('counters').findOneAndUpdate(
    { _id: 'issueTracking' },
    { $inc: { sequence_value: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return `CF-${new Date().getFullYear()}-${r.sequence_value.toString().padStart(5, '0')}`;
};

app.get('/', (req, res) => res.send('City Fixer Server is running'));

// ── AI Chatbot Route (WORKING with gemini-2.5-flash) 

// ── AI Chatbot Route with Gemini + OpenRouter Fallback ─────────────────────────────────────────
app.post('/api/chat', verifyToken, async (req, res) => {
  try {
    const { message, context = {} } = req.body;
    
    if (!message || message.trim() === '') {
      return res.status(400).send({ reply: 'Please ask me a question! 🤔' });
    }

    const { userRole = 'citizen', isPremium = false, userName = 'there' } = context;

    // System prompt for the AI
    const systemPrompt = `You are the CityFix Assistant, a helpful and friendly AI chatbot for the CityFix platform — a civic issue reporting system that lets citizens report, track, and resolve city infrastructure problems in Bangladesh.

IMPORTANT RULES:
- Always be friendly and conversational
- Use emojis appropriately to keep responses engaging
- Acknowledge greetings naturally (e.g., "How are you?" → "I'm doing great, thanks for asking!")
- Say "thank you" and "you're welcome" appropriately
- Be enthusiastic about helping users
- Keep responses under 200 words

CONVERSATION EXAMPLES:
- User: "How are you?" → "I'm doing great! Thanks for asking 😊 How can I help you with CityFix today?"
- User: "Thank you" → "You're very welcome! 🎉 Is there anything else you'd like to know?"
- User: "Good morning" → "Good morning! ☀️ Ready to help with any civic issues today!"
- User: "Hello" → "Hello! 👋 Welcome to CityFix Assistant! How can I make your day better?"

CURRENT USER INFO:
- Name: ${userName}
- Role: ${userRole}
- Premium: ${isPremium ? 'Yes' : 'No'}

YOUR PERSONALITY:
- Friendly, concise, and helpful
- Use short paragraphs and bullet points where appropriate
- Always be encouraging and supportive
- Use occasional relevant emojis to stay engaging
- If unsure, recommend contacting support
- Keep responses under 200 words unless the question genuinely requires more detail

COMPLETE PLATFORM KNOWLEDGE:

## USER ROLES
1. **Citizen** — Regular users who report and track issues. Free plan allows up to 3 reports. Premium is unlimited.
2. **Staff** — Field workers assigned to fix issues. They update issue status (In Progress → Resolved → Closed).
3. **Admin** — Platform managers. They manage users, assign issues to staff, approve staff requests, manage payments, and have full platform access.

## HOW TO REPORT AN ISSUE (Citizens)
1. Log in to your account
2. Click "+ Report Issue" from your dashboard or the top bar
3. Fill in: Title, Category (28 categories available), Location, Priority (Normal or High), Description
4. Upload a photo (optional but recommended)
5. Click "Submit Issue Report"
6. You'll receive a tracking ID (e.g., CF-2025-00001) for your issue

## ISSUE TRACKING & STATUSES
Issues go through these statuses:
- **Pending** — Just submitted, waiting for admin review
- **In Progress** — Assigned to a staff member who is actively working on it
- **Resolved** — Staff has completed the work
- **Closed** — Fully closed after resolution confirmed
- **Rejected** — Issue was rejected (duplicate, out of scope, invalid, etc.)

Citizens can track all their issues from Dashboard → My Issues.

## PREMIUM MEMBERSHIP
Free plan: Up to 3 issue reports total.
Premium plans (one-time payment, no auto-renewal):
- **Weekly** — ৳150/week
- **Monthly** — ৳500/month (most popular)
- **Yearly** — ৳4,500/year (save 25%)
Benefits: Unlimited issue reports, priority support, early features (yearly gets a profile badge too).
To upgrade: Dashboard → Profile → scroll to "Upgrade to Premium" → select plan → pay via Stripe.

## BECOMING STAFF
Citizens can apply to become staff:
1. Go to Dashboard → Profile
2. Scroll to "Become Staff" section
3. Write your reason/motivation
4. Submit the request
5. Admin reviews it — if approved, your role changes to Staff immediately

## STAFF CAPABILITIES
- View all assigned issues at Staff Dashboard → Assigned Issues
- Update issue status: Pending → In Progress → Resolved → Closed
- Add notes when updating status

## ADMIN CAPABILITIES
- **Admin Overview** — Full platform statistics
- **All Issues** — View, search, filter, assign, resolve, reject, or delete any issue
- **Manage Users** — View all citizens, verify emails, ban/unban users
- **Manage Staff** — View staff with stats and ratings
- **Staff Requests** — Approve or reject citizen applications
- **Payments** — View all platform transactions

## UPVOTING ISSUES
- Citizens can upvote any issue that isn't their own
- Each citizen can upvote an issue only once
- Higher upvotes signal priority to admins

## COMMENTS & FEEDBACK
- All users can comment on issue detail pages
- Citizens, Staff, and Admins can all comment — their role is shown next to the name
- Admins can delete any comment; citizens can delete their own

## RATING STAFF
- After an issue is **Resolved**, the citizen who reported it can rate the staff member (1–5 stars)
- Optional written feedback can be added
- Each citizen can only rate a staff member once per issue

## BOOSTING ISSUES
- Citizens can pay ৳100 to boost their issue to High Priority
- Moves issue to top of admin queue
- Available on issue detail page

Important: Keep responses helpful, friendly, and under 200 words.`;

    // Function to call OpenRouter
    const callOpenRouter = async (userMessage) => {
      try {
        const response = await openRouterClient.post('/chat/completions', {
          model: 'google/gemini-2.0-flash-exp:free',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
          ],
          max_tokens: 500,
          temperature: 0.7,
        });
        
        return response.data.choices[0]?.message?.content || null;
      } catch (err) {
        console.error('OpenRouter API error:', err.response?.data || err.message);
        return null;
      }
    };

    // Function to call Gemini
    const callGemini = async (userMessage) => {
      try {
        const model = genAI.getGenerativeModel({ model: 'models/gemini-2.5-flash' });
        const fullPrompt = `${systemPrompt}\n\nUser question: ${userMessage}\n\nAssistant response:`;
        const result = await model.generateContent(fullPrompt);
        const response = await result.response;
        return response.text();
      } catch (err) {
        console.error('Gemini API error:', err.message);
        return null;
      }
    };

    // Try Gemini first, fallback to OpenRouter
    let reply = await callGemini(message);
    
    // If Gemini fails or returns empty, try OpenRouter
    if (!reply || reply.trim() === '') {
      console.log('Gemini failed or returned empty, trying OpenRouter...');
      reply = await callOpenRouter(message);
    }

    // If both fail, provide comprehensive fallback responses
    if (!reply || reply.trim() === '') {
      const lowerMessage = message.toLowerCase();
      
      // ============ GREETINGS & CONVERSATIONAL ============
      if (lowerMessage.match(/^(hi|hello|hey|good morning|good afternoon|good evening)/)) {
        reply = `👋 Hello ${userName}! Welcome to CityFix Assistant! 😊\n\nI'm here to help you with reporting and tracking civic issues in your community. How can I assist you today?\n\nYou can ask me about:\n• 📝 Reporting issues\n• ⭐ Premium plans\n• 👨‍🔧 Becoming staff\n• 📊 Tracking issues\n• 💳 Payments\n• 🔍 Finding issues\n• ⭐ Rating staff\n\nWhat would you like to know?`;
      }
      else if (lowerMessage.includes('how are you') || lowerMessage.includes('how are u')) {
        reply = `I'm doing great, ${userName}! 🤖 Thanks for asking! I'm fully operational and ready to help you with CityFix platform.\n\nHow can I assist you today? 😊`;
      }
      else if (lowerMessage.includes('i am fine') || lowerMessage.includes('i\'m fine') || lowerMessage.includes('doing good')) {
        reply = `Glad to hear that, ${userName}! 😊 Is there anything I can help you with on CityFix today?`;
      }
      else if (lowerMessage.includes('thank') || lowerMessage.includes('thanks')) {
        reply = `You're very welcome, ${userName}! 🎉 I'm glad I could help. Is there anything else you'd like to know about CityFix?`;
      }
      else if (lowerMessage.includes('good') && (lowerMessage.includes('morning') || lowerMessage.includes('afternoon') || lowerMessage.includes('evening'))) {
        reply = `Good ${lowerMessage.includes('morning') ? 'morning' : lowerMessage.includes('afternoon') ? 'afternoon' : 'evening'}, ${userName}! ☀️ How can I help you with CityFix today?`;
      }
      
      // ============ ABOUT CITYFIX & TRUST ============
      else if (lowerMessage.includes('trust') || lowerMessage.includes('reliable') || lowerMessage.includes('safe')) {
        reply = `🔒 **Can you trust CityFix?** Absolutely!\n\nCityFix is a legitimate civic issue reporting platform designed with transparency and accountability:\n\n✅ **Secure Payments** — Stripe, world-class secure payment processor\n✅ **Transparent Tracking** — Every issue gets unique tracking ID (CF-2025-00001)\n✅ **Accountability** — Issues assigned to staff who update status in real-time\n✅ **Verified Users** — Email verification ensures genuine reporters\n✅ **Community Rated** — Citizens rate staff performance after resolution\n✅ **Admin Oversight** — Platform managed by administrators ensuring quality\n\nYour data is protected, payments are secure, we're committed to improving your community! 🏙️`;
      }
      else if (lowerMessage.includes('what is cityfix') || lowerMessage.includes('tell me about cityfix') || lowerMessage.includes('about cityfix')) {
        reply = `🏙️ **What is CityFix?**\n\nCityFix is a **civic issue reporting platform** helping citizens report, track, and resolve infrastructure problems in their community.\n\n**How it works:**\n1️⃣ **Report** — Citizens log issues (potholes, broken lights, garbage, etc.) with photos and location\n2️⃣ **Track** — Each issue gets unique tracking ID and status updates\n3️⃣ **Assign** — Admins assign issues to field staff\n4️⃣ **Resolve** — Staff fix issue and update status\n5️⃣ **Rate** — Citizens rate staff performance\n\n**Problems we solve:** 🛣️ Road damage, 💡 Street lights, 🗑️ Garbage collection, 💧 Water logging, 🌳 Parks maintenance, 🚦 Traffic signals, and 28+ categories!\n\nTogether, we build better communities! 🌟`;
      }
      else if (lowerMessage.includes('how does cityfix work') || lowerMessage.includes('how does it work')) {
        reply = `⚙️ **How CityFix Works - Step by Step:**\n\n**For Citizens:**\n📝 **Report** — Login → "+ Report Issue" → Fill details → Add photo → Submit → Get tracking ID\n🔍 **Track** — Dashboard → My Issues → See real-time status updates\n⭐ **Rate** — After issue resolved, rate staff 1-5 stars\n💎 **Premium** — Upgrade for unlimited reports (weekly/monthly/yearly)\n\n**For Staff:**\n🛠️ Receive assigned issues → Update status (Pending → In Progress → Resolved → Closed) → Add progress notes\n\n**For Admins:**\n👑 Manage users → Assign issues → Approve staff requests → View payments\n\nIssues flow: **Pending → In Progress → Resolved → Closed**\n\nSimple, transparent, and effective! 🎯`;
      }
      else if (lowerMessage.includes('how does it solve') || lowerMessage.includes('solve problem')) {
        reply = `🔧 **How CityFix Solves Community Problems:**\n\n**The Problem:** Citizens face infrastructure issues but don't know who to contact or when problems will be fixed.\n\n**CityFix Solution:**\n✅ **Centralized Reporting** — One platform for all civic issues\n✅ **Transparent Tracking** — Know exactly where your report is\n✅ **Accountability** — Staff assigned and rated by citizens\n✅ **Priority System** — Urgent issues can be "Boosted" to High Priority\n✅ **Community Power** — Upvote issues to highlight what matters most\n✅ **Data-Driven** — Admins see trends and allocate resources effectively\n✅ **Premium Support** — Priority handling for Premium members\n\n**Real Impact:** Faster response times, better resource allocation, and empowered communities! 🌍\n\nEvery report helps make your neighborhood better! 💪`;
      }
      else if (lowerMessage.includes('features') || lowerMessage.includes('what can i do')) {
        reply = `✨ **CityFix Features:**\n\n**For Everyone:**\n• 📝 Report civic issues with photos\n• 🔍 Track issues with unique tracking ID\n• 👍 Upvote important issues\n• 💬 Comment on any issue\n• 📊 View issue timelines\n\n**For Premium Members (from ৳150/week):**\n• ⭐ Unlimited issue reports\n• 🚀 Priority support\n• 🔔 Early access to new features\n\n**For Staff:**\n• 🛠️ View assigned issues\n• 📝 Update issue status\n• 💬 Add progress notes\n\n**For Admins:**\n• 👑 Full platform control\n• 👥 User management\n• 📊 Analytics and insights\n\nWhat feature would you like to know more about? 🎯`;
      }
      
      // ============ REPORTING ISSUES ============
      else if (lowerMessage.includes('how to report') || lowerMessage.includes('submit issue') || lowerMessage.includes('report an issue')) {
        reply = `📝 **How to Report an Issue on CityFix:**\n\n**Step-by-Step Guide:**\n\n1️⃣ **Login** to your CityFix account\n2️⃣ Click **"+ Report Issue"** button on your dashboard\n3️⃣ **Fill in the details:**\n   • **Title** — Brief description\n   • **Category** — Choose from 28 options\n   • **Location** — Specific address or landmark\n   • **Priority** — Normal or High (High costs ৳100 to boost)\n   • **Description** — Detailed explanation\n4️⃣ **Upload a photo** (recommended for faster resolution)\n5️⃣ Click **"Submit Issue Report"**\n\n✅ **You'll receive a tracking ID** (e.g., CF-2025-00001) to monitor progress!\n\n**Pro tip:** Clear photos and exact locations help staff resolve issues faster! 📸\n\nNeed premium for unlimited reports? Upgrade from your profile page! ⭐`;
      }
      else if (lowerMessage.includes('category') || lowerMessage.includes('categories') || lowerMessage.includes('type of issue')) {
        reply = `📂 **Available Issue Categories (28 total):**\n\n**Infrastructure:**\n🛣️ Road & Pavement, Pothole, Bridge & Overpass, Footpath & Sidewalk, Building & Construction, Illegal Construction\n\n**Utilities:**\n💧 Water Supply, Water Logging, Drainage & Sewage, Electricity & Lighting, Street Lighting, Gas Leak\n\n**Sanitation:**\n🗑️ Waste & Sanitation, Garbage Collection\n\n**Public Spaces:**\n🌳 Parks & Green Spaces, Public Transport, Traffic & Signals, Market & Public Space\n\n**Health & Safety:**\n🚨 Noise Pollution, Air Pollution, Flooding, Tree Hazard, Vandalism, Public Property Damage, Fire Hazard, Hospital & Health Facility\n\n**Education:**\n📚 School & Education Facility\n\n**Other:**\n📌 Other\n\nChoose the category that best matches your issue for faster routing! 🎯`;
      }
      
      // ============ TRACKING ISSUES ============
      else if (lowerMessage.includes('track') || lowerMessage.includes('status') || lowerMessage.includes('where is my issue')) {
        reply = `🔍 **How to Track Your Issues:**\n\n**Method 1 - Dashboard:**\n1️⃣ Go to your **Dashboard**\n2️⃣ Click **"My Issues"**\n3️⃣ See all your reported issues with current status\n\n**Method 2 - Tracking ID:**\nEnter your tracking ID (e.g., CF-2025-00001) to see specific issue details\n\n**Issue Status Meanings:**\n📋 **Pending** — Just submitted, waiting for admin review\n⚙️ **In Progress** — Assigned to staff, being worked on\n✅ **Resolved** — Issue has been fixed\n🔒 **Closed** — Fully completed and verified\n❌ **Rejected** — Invalid or out of scope\n\n**Timeline:** Click "View" on any issue to see complete history including who updated it and when!\n\nNeed updates? Check your email or the platform regularly! 📧`;
      }
      
      // ============ PREMIUM PLANS ============
      else if (lowerMessage.includes('premium') || lowerMessage.includes('upgrade') || lowerMessage.includes('membership')) {
        reply = `⭐ **CityFix Premium Plans**\n\n**One-time payment, no auto-renewal:**\n\n• **Weekly** — ৳150/week\n  Good for short-term use\n\n• **Monthly** — ৳500/month  ← Most Popular!\n  Best value for regular users\n\n• **Yearly** — ৳4,500/year  ← Save 25%!\n  Best deal with exclusive profile badge\n\n**Premium Benefits:**\n✅ **Unlimited issue reports** (Free plan: only 3 total)\n✅ **Priority support** — Your issues get faster attention\n✅ **Early access** — New features first\n✅ **Profile badge** — Show you're a supporter (Yearly plan)\n\n**How to Upgrade:**\nDashboard → Profile → "Upgrade to Premium" → Select plan → Pay securely via Stripe\n\n**Questions?** Ask me about payment security or plan details! 💳`;
      }
      else if (lowerMessage.includes('payment') || lowerMessage.includes('pay') || lowerMessage.includes('cost') || lowerMessage.includes('price')) {
        reply = `💳 **Payments on CityFix:**\n\n**Secure Payments via Stripe** 🔒\n• Industry-leading security\n• No credit card details stored on our servers\n• SSL encrypted transactions\n\n**What You Can Pay For:**\n\n**1. Boost Priority** — ৳100 one-time\n   • Moves issue to "High" priority\n   • Puts issue at top of admin queue\n   • Available on any issue detail page\n\n**2. Premium Membership** — One-time payment, no renewal\n   • Weekly: ৳150\n   • Monthly: ৳500 (Most Popular)\n   • Yearly: ৳4,500 (Save 25%)\n   • Benefits: Unlimited reports + Priority support\n\n**How to Pay:**\n1️⃣ Dashboard → Profile\n2️⃣ Click "Upgrade to Premium" or "Boost"\n3️⃣ Select plan/option\n4️⃣ Complete payment via Stripe\n5️⃣ Instant activation!\n\n**Refund Policy:** Contact support@cityfix.com for issues. All payments are final unless technical error occurs. 💰`;
      }
      
      // ============ STAFF RELATED ============
      else if (lowerMessage.includes('become staff') || lowerMessage.includes('staff member') || lowerMessage.includes('how to be staff')) {
        reply = `👨‍🔧 **How to Become a CityFix Staff Member:**\n\n**Eligibility:**\n• Must be a registered citizen\n• No premium required\n• Passion for community service\n\n**Application Process:**\n\n1️⃣ Go to **Dashboard → Profile**\n2️⃣ Scroll to **"Become Staff"** section\n3️⃣ Write your **reason/motivation**\n4️⃣ Click **"Submit Request"**\n5️⃣ Admin reviews your application\n6️⃣ If approved → Role changes to Staff immediately!\n\n**Staff Capabilities:**\n• 🛠️ View assigned issues\n• 📝 Update issue status (Pending → In Progress → Resolved → Closed)\n• 💬 Add progress notes\n• ⭐ Get rated by citizens\n\n**Processing Time:** Usually 24-48 hours for review\n\nReady to make a difference in your community? Apply today! 🌟`;
      }
      else if (lowerMessage.includes('admin') || lowerMessage.includes('administrator')) {
        reply = `👑 **Admin Capabilities - Full Platform Control:**\n\n**Dashboard & Analytics:**\n• 📊 View platform statistics\n• 📈 Track platform performance\n\n**Issue Management:**\n• 📋 View, search, and filter all issues\n• 🛠️ Assign issues to staff members\n• ✅ Resolve or reject any issue\n• 🗑️ Delete inappropriate issues\n\n**User Management:**\n• 👥 View all registered citizens\n• ✅ Verify or unverify email addresses\n• 🚫 Ban/unban users\n\n**Staff Management:**\n• 📋 View all staff with work stats\n• ⭐ See staff ratings from citizens\n• 📝 Assign issues to specific staff\n\n**Payment Management:**\n• 💳 View all platform transactions\n• 📊 Track revenue\n\n**Staff Requests:**\n• 📬 Approve or reject citizen applications\n\nAdmins ensure CityFix runs smoothly and issues are resolved efficiently! 🔧`;
      }
      
      // ============ UPVOTES & COMMENTS ============
      else if (lowerMessage.includes('upvote') || lowerMessage.includes('vote')) {
        reply = `👍 **How Upvoting Works on CityFix:**\n\n**What is Upvoting?**\nUpvoting shows support for issues others care about.\n\n**Rules:**\n✅ Citizens can upvote any issue (except their own)\n✅ Each citizen can upvote an issue only once\n✅ Staff and Admins cannot upvote\n✅ Higher upvotes = More visibility to admins\n\n**Why Upvote?**\n• 🎯 Helps prioritize community concerns\n• 📊 Shows which issues affect the most people\n• 🚀 Affects admin decision-making\n\n**How to Upvote:**\n1️⃣ Go to **All Issues** page\n2️⃣ Find an issue you care about\n3️⃣ Click the **upvote button**\n4️⃣ Watch the count increase!\n\nEvery upvote makes a difference! Make your voice heard! 🗣️`;
      }
      else if (lowerMessage.includes('comment') || lowerMessage.includes('feedback')) {
        reply = `💬 **Comments & Feedback on CityFix:**\n\n**Who Can Comment?**\n✅ Anyone logged in (Citizens, Staff, Admins)\n✅ Your role badge appears next to your name\n\n**How to Comment:**\n1️⃣ Go to any issue detail page\n2️⃣ Scroll to **"Comments"** section\n3️⃣ Type your comment\n4️⃣ Click **"Post Comment"**\n\n**What Can You Comment On?**\n• 📝 Share additional information\n• 🙏 Thank staff for their work\n• 💡 Suggest solutions\n• ❓ Ask questions\n\n**Comment Moderation:**\n• 🗑️ Issue owners can delete comments on their issues\n• 👑 Admins can delete any comment\n\nKeep comments respectful and helpful! 🤝`;
      }
      else if (lowerMessage.includes('rating') || lowerMessage.includes('rate staff')) {
        reply = `⭐ **Staff Rating System:**\n\n**When Can You Rate?**\nAfter an issue is marked **"Resolved"**\n\n**Who Can Rate?**\nOnly the citizen who **reported** the issue (one rating per issue)\n\n**How to Rate:**\n1️⃣ Go to resolved issue detail page\n2️⃣ Look for **"Rate Staff"** section\n3️⃣ Select **1-5 stars**\n4️⃣ Add optional **written feedback**\n5️⃣ Click **"Submit Rating"**\n\n**Why Rating Matters:**\n• 📊 Helps admins evaluate staff performance\n• 🏆 Recognizes outstanding staff\n• 📈 Drives service improvement\n\nRate fairly based on actual service quality! 🌟`;
      }
      
      // ============ BOOSTING ============
      else if (lowerMessage.includes('boost') || lowerMessage.includes('high priority')) {
        reply = `🚀 **Boost Your Issue to High Priority!**\n\n**What is Boosting?**\nA paid feature (৳100) that moves your issue to the top of the admin queue with "High Priority" status.\n\n**Why Boost?**\n• 🔥 **Gets faster attention** from admins\n• 📍 **Higher visibility** among all issues\n• ⚡ **Expedited processing**\n\n**How to Boost:**\n1️⃣ Go to your **issue detail page**\n2️⃣ Look for **"Boost Priority — ৳100"** button\n3️⃣ Click to proceed with Stripe payment\n4️⃣ Complete secure payment\n5️⃣ Issue priority changes to **High** instantly!\n\n**Important Notes:**\n• ✅ Can only boost your own issues\n• ⏰ Works best for urgent/time-sensitive problems\n• 💰 One-time payment, no subscription\n• 🔒 Payment processed securely via Stripe\n\nMake your voice heard faster! 🎯`;
      }
      
      // ============ TROUBLESHOOTING ============
      else if (lowerMessage.includes('can\'t report') || lowerMessage.includes('cannot report') || lowerMessage.includes('limit reached')) {
        reply = `⚠️ **Can't Report an Issue? Here's Why:**\n\n**Common Reasons:**\n\n1️⃣ **Free Limit Reached** (Most Common)\n   • Free plan = Only 3 total reports\n   • Solution: **Upgrade to Premium** (from ৳150/week)\n\n2️⃣ **Account Blocked**\n   • You may have been blocked by an admin\n   • Solution: Contact support@cityfix.com\n\n3️⃣ **Not Logged In**\n   • Need to be logged in to report issues\n   • Solution: Login or create an account\n\n4️⃣ **Missing Required Fields**\n   • Title, category, and location are required\n   • Make sure all fields are filled\n\n**Still having issues?** Contact support@cityfix.com\n\n**Premium Upgrade:** Dashboard → Profile → "Upgrade to Premium" → Get unlimited reports! ⭐`;
      }
      else if (lowerMessage.includes('login') || lowerMessage.includes('sign in') || lowerMessage.includes('account')) {
        reply = `🔐 **Account & Login Help:**\n\n**Creating an Account:**\n1️⃣ Click **"Register"** on the homepage\n2️⃣ Enter email and password\n3️⃣ Verify your email (check inbox)\n4️⃣ Complete profile setup\n\n**Login Issues?**\n• **Forgot Password?** Click "Forgot Password" on login page\n• **Email not verified?** Check your spam folder\n• **Account blocked?** Contact support\n\n**Account Features:**\n• 📝 Update profile photo (upload directly)\n• 👤 Change display name\n• 🔒 Secure Firebase authentication\n• 📧 Email verification for security\n\n**Profile Management:**\n• Dashboard → Profile\n• Update personal info\n• Upgrade to Premium\n• Apply for Staff role\n\nNeed help? support@cityfix.com 🔒`;
      }
      
      // ============ CONTACT & SUPPORT ============
      else if (lowerMessage.includes('contact') || lowerMessage.includes('support') || lowerMessage.includes('help')) {
        reply = `📞 **Contact & Support:**\n\n**Platform Support:**\n📧 Email: **support@cityfix.com**\n🕐 Response time: 24-48 hours\n\n**For Urgent Issues (Emergencies):**\n🚨 Call **local emergency services** immediately\n• CityFix is for non-emergency civic issues\n\n**Common Support Topics:**\n• 🔧 Technical issues\n• 💳 Payment problems\n• 👤 Account recovery\n• 📝 Issue reporting help\n• ⭐ Staff rating questions\n\n**Admin Contact:**\n• For business inquiries: admin@cityfix.com\n\nWe're here to help make your community better! 🏙️`;
      }
      
      // ============ DEFAULT ============
      else {
        reply = `🤖 Hi ${userName}! I'm CityFix Assistant.\n\nI can help you with:\n\n📝 **Reporting Issues** — How to submit and track problems\n⭐ **Premium Plans** — Unlimited reports from ৳150/week\n👨‍🔧 **Becoming Staff** — Join our field team\n📊 **Tracking Issues** — Monitor your reports\n💳 **Payments** — Secure Stripe payments\n👍 **Upvoting** — Support important issues\n💬 **Comments** — Engage with community\n⭐ **Rating Staff** — Share your feedback\n🔒 **Trust & Safety** — Platform reliability\n🚀 **Boosting** — Get priority attention\n\n**Quick Commands:**\n• "How to report an issue?"\n• "Tell me about Premium"\n• "How to become staff?"\n• "Track my issue"\n• "Is CityFix trustworthy?"\n• "What is CityFix?"\n\nWhat would you like to know? 😊\n\n*Need immediate help? Contact support@cityfix.com*`;
      }
    }

    // Ensure response is trimmed
    reply = reply.trim();
    
    if (!reply) {
      reply = "I'm having technical difficulties right now. Please try again in a moment or check our Help section for common questions! 🙏\n\nYou can also email support@cityfix.com for immediate assistance.";
    }

    res.send({ reply });
    
  } catch (err) {
    console.error('Chat route error:', err);
    
    // Provide a graceful fallback for any unexpected errors
    res.status(500).send({ 
      reply: "I'm temporarily unavailable. Please try again in a few minutes, or check the Help section on our platform!\n\nFor urgent issues, please contact support@cityfix.com 📧" 
    });
  }
});

async function run() {
  try {
    await client.connect();
    const db = client.db('cityFixerDB');
    const issuesCol = db.collection('issues');
    const paymentsCol = db.collection('payments');
    const usersCol = db.collection('users');
    const staffRequestsCol = db.collection('staffRequests');
    const commentsCol = db.collection('comments');
    const ratingsCol = db.collection('ratings');

    // ══════════════════════════════════════════════════════════════════════════
    //  USER ROUTES
    // ══════════════════════════════════════════════════════════════════════════

    app.post('/users', async (req, res) => {
      try {
        const { email, name, photo } = req.body;
        if (!email) return res.status(400).send({ message: 'Email required' });
        const existing = await usersCol.findOne({ email });
        if (existing) {
          await usersCol.updateOne({ email }, { $set: { name: name || existing.name, photo: photo || existing.photo } });
          return res.send({ message: 'Updated', role: existing.role });
        }
        const result = await usersCol.insertOne({
          email, name: name || '', photo: photo || '',
          role: 'citizen', isBlocked: false, isPremium: false,
          isEmailVerified: false, createdAt: new Date(),
        });
        res.send(result);
      } catch { res.status(500).send({ message: 'Server error' }); }
    });

    app.get('/users/me', verifyToken, async (req, res) => {
      const u = await usersCol.findOne({ email: req.user.email });
      if (!u) return res.status(404).send({ message: 'Not found' });
      res.send(u);
    });

    app.get('/users/role/:email', verifyToken, async (req, res) => {
      if (req.user.email !== req.params.email) return res.status(403).send({ message: 'Forbidden' });
      const u = await usersCol.findOne({ email: req.params.email });
      res.send({ role: u?.role || 'citizen', isBlocked: u?.isBlocked || false, isPremium: u?.isPremium || false });
    });

    // Admin: get all citizens with issueCount
    app.get('/users/citizens', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { limit = 20, skip = 0 } = req.query;
        const users = await usersCol.find({ role: 'citizen' }).sort({ createdAt: -1 }).skip(Number(skip)).limit(Number(limit)).toArray();
        const withCount = await Promise.all(users.map(async u => ({
          ...u, issueCount: await issuesCol.countDocuments({ reportedBy: u.email }),
        })));
        res.send(withCount);
      } catch { res.status(500).send({ message: 'Failed' }); }
    });

    // Admin: get all staff with work stats and average rating
    app.get('/users/staff', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const users = await usersCol.find({ role: 'staff' }).sort({ createdAt: -1 }).toArray();
        const withStats = await Promise.all(users.map(async u => {
          const [assignedCount, resolvedCount, inProgressCount, ratingAgg] = await Promise.all([
            issuesCol.countDocuments({ assignedTo: u.email }),
            issuesCol.countDocuments({ assignedTo: u.email, status: 'Resolved' }),
            issuesCol.countDocuments({ assignedTo: u.email, status: 'In Progress' }),
            ratingsCol.aggregate([{ $match: { staffEmail: u.email } }, { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }]).toArray(),
          ]);
          return { ...u, assignedCount, resolvedCount, inProgressCount, avgRating: ratingAgg[0]?.avg || 0, ratingCount: ratingAgg[0]?.count || 0 };
        }));
        res.send(withStats);
      } catch { res.status(500).send({ message: 'Failed' }); }
    });

    app.get('/users/by-email/:email', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const email = req.params.email;
        const user = await usersCol.findOne({ email });
        
        if (!user) {
          return res.status(404).send({ message: 'User not found' });
        }
        
        // Get issue counts for this user
        const issueCount = await issuesCol.countDocuments({ reportedBy: email });
        const resolvedCount = await issuesCol.countDocuments({ reportedBy: email, status: 'Resolved' });
        
        res.send({
          ...user,
          issueCount,
          resolvedCount
        });
      } catch (err) {
        console.error('Error fetching user by email:', err);
        res.status(500).send({ message: 'Failed to fetch user' });
      }
    });

    // Admin: block/unblock user
    app.patch('/users/:email/block', verifyToken, verifyAdmin, async (req, res) => {
      res.send(await usersCol.updateOne({ email: req.params.email }, { $set: { isBlocked: req.body.isBlocked } }));
    });

    // Admin: verify/unverify user email (syncs with Firebase)
    app.patch('/users/:email/verify', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { isEmailVerified } = req.body;
        const email = req.params.email;
        
        // Update MongoDB
        const result = await usersCol.updateOne(
          { email },
          { $set: { isEmailVerified: !!isEmailVerified } }
        );
        
        // Also update Firebase user's emailVerified status
        try {
          const firebaseUser = await admin.auth().getUserByEmail(email);
          await admin.auth().updateUser(firebaseUser.uid, {
            emailVerified: !!isEmailVerified
          });
          console.log(`Firebase user ${email} emailVerified set to ${!!isEmailVerified}`);
        } catch (firebaseErr) {
          console.error('Failed to update Firebase user:', firebaseErr.message);
          // Don't fail the request if Firebase update fails, just log it
        }
        
        res.send({ 
          message: isEmailVerified ? 'User email verified' : 'Verification removed',
          result 
        });
      } catch (err) { 
        console.error('Verification error:', err);
        res.status(500).send({ message: 'Failed to update verification status' });
      }
    });

    // Role change — body-based (Make Staff, Remove Staff)
    app.patch('/users/role', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { email, role } = req.body;
        if (!email || !role) return res.status(400).send({ message: 'email and role required' });
        if (!['citizen', 'staff', 'admin'].includes(role)) return res.status(400).send({ message: 'Invalid role' });
        const result = await usersCol.updateOne({ email }, { $set: { role } });
        if (result.matchedCount === 0) return res.status(404).send({ message: 'User not found' });
        res.send({ message: `Role updated to ${role}` });
      } catch { res.status(500).send({ message: 'Failed' }); }
    });

    app.patch('/users/:email/role', verifyToken, verifyAdmin, async (req, res) => {
      res.send(await usersCol.updateOne({ email: req.params.email }, { $set: { role: req.body.role } }));
    });

    // Ban user
    app.patch('/users/ban', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { email } = req.body;
        if (!email) return res.status(400).send({ message: 'email required' });
        res.send(await usersCol.updateOne({ email }, { $set: { isBlocked: true } }));
      } catch { res.status(500).send({ message: 'Failed' }); }
    });

    app.patch('/users/me/premium', verifyToken, async (req, res) => {
      res.send(await usersCol.updateOne({ email: req.user.email }, { $set: { isPremium: true } }));
    });

    // ══════════════════════════════════════════════════════════════════════════
    //  STAFF REQUEST ROUTES
    // ══════════════════════════════════════════════════════════════════════════

    app.post('/staff-requests', verifyToken, async (req, res) => {
      try {
        const email = req.user.email;
        const user = await usersCol.findOne({ email });
        if (!user) return res.status(404).send({ message: 'User not found' });
        if (user.role !== 'citizen') return res.status(400).send({ message: 'Only citizens can request staff role' });

        const existing = await staffRequestsCol.findOne({ email, status: 'pending' });
        if (existing) return res.status(409).send({ message: 'You already have a pending staff request' });

        const result = await staffRequestsCol.insertOne({
          email,
          name: user.name || '',
          photo: user.photo || '',
          reason: req.body.reason || '',
          status: 'pending',
          createdAt: new Date(),
        });
        res.send({ message: 'Staff request submitted', result });
      } catch { res.status(500).send({ message: 'Failed to submit request' }); }
    });

    app.get('/staff-requests/my', verifyToken, async (req, res) => {
      try {
        const request = await staffRequestsCol.findOne(
          { email: req.user.email },
          { sort: { createdAt: -1 } }
        );
        res.send(request || null);
      } catch { res.status(500).send({ message: 'Failed' }); }
    });

    app.get('/staff-requests', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { status = 'pending' } = req.query;
        const requests = await staffRequestsCol.find({ status }).sort({ createdAt: -1 }).toArray();
        res.send(requests);
      } catch { res.status(500).send({ message: 'Failed' }); }
    });

    app.patch('/staff-requests/:id', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { action } = req.body;
        const requestDoc = await staffRequestsCol.findOne({ _id: new ObjectId(req.params.id) });
        if (!requestDoc) return res.status(404).send({ message: 'Request not found' });

        if (action === 'approve') {
          await usersCol.updateOne({ email: requestDoc.email }, { $set: { role: 'staff' } });
          await staffRequestsCol.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { status: 'approved', resolvedAt: new Date() } }
          );
          res.send({ message: `${requestDoc.email} is now staff` });
        } else if (action === 'reject') {
          await staffRequestsCol.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { status: 'rejected', resolvedAt: new Date() } }
          );
          res.send({ message: 'Request rejected' });
        } else {
          res.status(400).send({ message: 'action must be approve or reject' });
        }
      } catch { res.status(500).send({ message: 'Failed' }); }
    });

    // ══════════════════════════════════════════════════════════════════════════
    //  COMMENTS & RATINGS ROUTES
    // ══════════════════════════════════════════════════════════════════════════

    // Add comment to issue
    app.post('/comments', verifyToken, async (req, res) => {
      try {
        const { issueId, text } = req.body;
        if (!issueId || !text) return res.status(400).send({ message: 'Issue ID and text required' });
        
        const user = await usersCol.findOne({ email: req.user.email });
        const comment = {
          issueId: new ObjectId(issueId),
          text,
          userId: req.user.email,
          userName: user?.name || req.user.email,
          userPhoto: user?.photo || '',
          role: user?.role || 'citizen',
          createdAt: new Date(),
        };
        const result = await commentsCol.insertOne(comment);
        res.send({ message: 'Comment added', comment: { ...comment, _id: result.insertedId } });
      } catch { res.status(500).send({ message: 'Failed to add comment' }); }
    });

    // Get comments for an issue
    app.get('/comments/:issueId', async (req, res) => {
      try {
        const comments = await commentsCol.find({ issueId: new ObjectId(req.params.issueId) }).sort({ createdAt: -1 }).toArray();
        res.send(comments);
      } catch { res.status(500).send({ message: 'Failed to fetch comments' }); }
    });

    // Delete comment (owner or admin)
    app.delete('/comments/:id', verifyToken, async (req, res) => {
      try {
        const comment = await commentsCol.findOne({ _id: new ObjectId(req.params.id) });
        if (!comment) return res.status(404).send({ message: 'Comment not found' });
        
        const user = await usersCol.findOne({ email: req.user.email });
        if (comment.userId !== req.user.email && user?.role !== 'admin') {
          return res.status(403).send({ message: 'Forbidden' });
        }
        
        await commentsCol.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send({ message: 'Comment deleted' });
      } catch { res.status(500).send({ message: 'Failed to delete comment' }); }
    });

    // Rate staff member (citizen can rate staff after issue is resolved)
    app.post('/ratings', verifyToken, async (req, res) => {
      try {
        const { staffEmail, issueId, rating, feedback } = req.body;
        if (!staffEmail || !issueId || !rating) return res.status(400).send({ message: 'Missing required fields' });
        if (rating < 1 || rating > 5) return res.status(400).send({ message: 'Rating must be between 1 and 5' });
        
        const user = await usersCol.findOne({ email: req.user.email });
        if (user?.role !== 'citizen') return res.status(403).send({ message: 'Only citizens can rate staff' });
        
        // Check if user has already rated this staff for this issue
        const existing = await ratingsCol.findOne({ issueId: new ObjectId(issueId), ratedBy: req.user.email });
        if (existing) return res.status(409).send({ message: 'You have already rated this staff for this issue' });
        
        // Check if issue is resolved and assigned to this staff
        const issue = await issuesCol.findOne({ _id: new ObjectId(issueId) });
        if (!issue || issue.status !== 'Resolved') return res.status(400).send({ message: 'You can only rate staff after the issue is resolved' });
        if (issue.assignedTo !== staffEmail) return res.status(400).send({ message: 'This staff was not assigned to this issue' });
        
        const ratingDoc = {
          staffEmail,
          staffName: (await usersCol.findOne({ email: staffEmail }))?.name || staffEmail,
          issueId: new ObjectId(issueId),
          issueTitle: issue.title,
          rating: Number(rating),
          feedback: feedback || '',
          ratedBy: req.user.email,
          ratedByName: user?.name || req.user.email,
          createdAt: new Date(),
        };
        
        const result = await ratingsCol.insertOne(ratingDoc);
        
        // Update staff's average rating in users collection
        const allRatings = await ratingsCol.find({ staffEmail }).toArray();
        const avgRating = allRatings.reduce((sum, r) => sum + r.rating, 0) / allRatings.length;
        await usersCol.updateOne({ email: staffEmail }, { $set: { avgRating, ratingCount: allRatings.length } });
        
        res.send({ message: 'Rating submitted', rating: { ...ratingDoc, _id: result.insertedId } });
      } catch { res.status(500).send({ message: 'Failed to submit rating' }); }
    });

    // Get ratings for a staff member
    app.get('/ratings/:staffEmail', async (req, res) => {
      try {
        const ratings = await ratingsCol.find({ staffEmail: req.params.staffEmail }).sort({ createdAt: -1 }).toArray();
        const avg = ratings.reduce((sum, r) => sum + r.rating, 0) / (ratings.length || 1);
        res.send({ ratings, avgRating: avg, count: ratings.length });
      } catch { res.status(500).send({ message: 'Failed to fetch ratings' }); }
    });

    // ══════════════════════════════════════════════════════════════════════════
    //  ISSUE ROUTES
    // ══════════════════════════════════════════════════════════════════════════

    app.post('/issues', verifyToken, async (req, res) => {
      try {
        const email = req.user.email;
        const user = await usersCol.findOne({ email });
        
        if (user?.isBlocked) return res.status(403).send({ message: 'You are blocked from reporting issues.' });
        
        // Check free limit for non-premium users
        if (!user?.isPremium && await issuesCol.countDocuments({ reportedBy: email }) >= 3) {
          return res.status(403).send({ message: 'Free limit reached. Upgrade to Premium to report more.' });
        }
        
        // PREMIUM FEATURE: Auto-boost premium users' issues to High priority
        let priority = req.body.priority === 'High' ? 'High' : 'Normal';
        if (user?.isPremium) {
          priority = 'High'; // Premium users automatically get High priority
        }
        
        const trackingId = await getNextTrackingId(db);
        
        // Create timeline message
        let timelineMessage = 'Issue reported by citizen';
        if (user?.isPremium) {
          timelineMessage = '⭐ Premium user issue - Auto-boosted to High Priority';
        }
        
        const result = await issuesCol.insertOne({
          ...req.body,
          priority,
          trackingId,
          reportedBy: email,
          reporterName: user?.name || '',
          reporterPhoto: user?.photo || '',
          reporterIsPremium: user?.isPremium || false,
          upvotes: 0,
          upvotedBy: [],
          createdAt: new Date(),
          status: user?.isPremium ? 'In Progress' : 'Pending', // Premium issues go directly to In Progress
          timeline: [{
            trackingId,
            status: user?.isPremium ? 'In Progress' : 'Pending',
            message: timelineMessage,
            updatedBy: email,
            updaterName: user?.name || email,
            role: 'citizen',
            timestamp: new Date(),
          }],
        });
        
        res.send(result);
      } catch (err) { 
        console.error(err);
        res.status(500).send({ message: 'Failed to create issue' }); 
      }
    });

    
    app.get('/issues', async (req, res) => {
      try {
        const { status, priority, category, search, limit, skip, reportedBy, assignedTo } = req.query;
        const query = {};
        if (reportedBy) query.reportedBy = reportedBy;
        if (assignedTo) query.assignedTo = assignedTo;
        if (status) query.status = { $in: status.split(',') };
        if (priority) query.priority = { $in: priority.split(',') };
        if (category) query.category = { $in: category.split(',') };
        if (search) query.$or = [
          { title: { $regex: search, $options: 'i' } },
          { category: { $regex: search, $options: 'i' } },
          { location: { $regex: search, $options: 'i' } },
        ];
        
        // Set default limit and skip
        const limitNum = parseInt(limit) || 10;
        const skipNum = parseInt(skip) || 0;
        
        const result = await issuesCol.aggregate([
          { $match: query },
          {
            $lookup: {
              from: 'users',
              localField: 'reportedBy',
              foreignField: 'email',
              as: 'reporterInfo'
            }
          },
          {
            $addFields: {
              reporterIsPremium: { 
                $cond: {
                  if: { $gt: [{ $size: '$reporterInfo' }, 0] },
                  then: { $arrayElemAt: ['$reporterInfo.isPremium', 0] },
                  else: false
                }
              },
              reporterName: {
                $cond: {
                  if: { $gt: [{ $size: '$reporterInfo' }, 0] },
                  then: { $arrayElemAt: ['$reporterInfo.name', 0] },
                  else: ''
                }
              },
              priorityOrder: { $cond: [{ $eq: ['$priority', 'High'] }, 1, 2] }
            }
          },
          { $sort: { priorityOrder: 1, createdAt: -1 } },
          { $skip: skipNum },
          { $limit: limitNum },
          { $project: { reporterInfo: 0 } }
        ]).toArray();
        
        res.send(result);
      } catch (err) { 
        console.error('Issues fetch error:', err);
        res.status(500).send({ message: 'Failed to fetch issues', error: err.message }); 
      }
    });

    app.get('/issues/resolved', async (req, res) => {
      res.send(await issuesCol.find({ status: 'Resolved' }).sort({ createdAt: -1 }).limit(6).toArray());
    });

    app.get('/issues/count', async (req, res) => {
      const { status, priority, category, search, reportedBy, assignedTo } = req.query;
      const query = {};
      if (reportedBy) query.reportedBy = reportedBy;
      if (assignedTo) query.assignedTo = assignedTo;
      if (status) query.status = { $in: status.split(',') };
      if (priority) query.priority = { $in: priority.split(',') };
      if (category) query.category = { $in: category.split(',') };
      if (search) query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } },
        { location: { $regex: search, $options: 'i' } },
      ];
      res.send({ count: await issuesCol.countDocuments(query) });
    });

    app.patch('/issues/:id/upvote', verifyToken, async (req, res) => {
      try {
        const email = req.user.email;
        const user = await usersCol.findOne({ email });
        if (user?.role === 'admin' || user?.role === 'staff')
          return res.status(403).send({ message: 'Only citizens can upvote.' });
        const issue = await issuesCol.findOne({ _id: new ObjectId(req.params.id) });
        if (!issue) return res.status(404).send({ message: 'Issue not found' });
        if (issue.reportedBy === email)
          return res.status(403).send({ message: 'You cannot upvote your own issue.' });
        if (Array.isArray(issue.upvotedBy) && issue.upvotedBy.includes(email))
          return res.status(409).send({ message: 'You have already upvoted this issue.' });
        await issuesCol.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $inc: { upvotes: 1 }, $addToSet: { upvotedBy: email } }
        );
        res.send({ message: 'Upvoted successfully' });
      } catch { res.status(500).send({ message: 'Failed to upvote' }); }
    });

    app.patch('/issues/:id/assign', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const assignedTo = req.body.assignedTo || req.body.staffEmail;
        if (!assignedTo) return res.status(400).send({ message: 'assignedTo required' });
        const staffUser = await usersCol.findOne({ email: assignedTo, role: 'staff' });
        if (!staffUser) return res.status(404).send({ message: 'Staff not found' });
        const issue = await issuesCol.findOne({ _id: new ObjectId(req.params.id) });
        if (!issue) return res.status(404).send({ message: 'Issue not found' });
        const adminUser = await usersCol.findOne({ email: req.user.email });
        await issuesCol.updateOne(
          { _id: new ObjectId(req.params.id) },
          {
            $set: { assignedTo, assignedStaffName: staffUser.name || assignedTo, status: 'In Progress', updatedAt: new Date() },
            $push: {
              timeline: {
                trackingId: issue.trackingId,
                status: 'In Progress',
                message: `Issue assigned to ${staffUser.name || assignedTo}`,
                updatedBy: req.user.email,
                updaterName: adminUser?.name || req.user.email,
                role: 'admin',
                timestamp: new Date(),
              },
            },
          }
        );
        res.send({ message: 'Assigned successfully' });
      } catch { res.status(500).send({ message: 'Assignment failed' }); }
    });

    app.patch('/issues/:id/status', verifyToken, verifyAdminOrStaff, async (req, res) => {
      try {
        const { status, message } = req.body;
        const email = req.user.email;
        const user = await usersCol.findOne({ email });
        const issue = await issuesCol.findOne({ _id: new ObjectId(req.params.id) });
        if (!issue) return res.status(404).send({ message: 'Issue not found' });
        if (user?.role === 'staff' && issue.assignedTo !== email)
          return res.status(403).send({ message: 'Can only update your assigned issues' });
        await issuesCol.updateOne(
          { _id: new ObjectId(req.params.id) },
          {
            $set: { status, updatedAt: new Date() },
            $push: {
              timeline: {
                trackingId: issue.trackingId,
                status,
                message: message || `Status updated to ${status}`,
                updatedBy: email,
                updaterName: user?.name || email,
                role: user?.role || 'staff',
                timestamp: new Date(),
              },
            },
          }
        );
        res.send({ message: 'Status updated' });
      } catch { res.status(500).send({ message: 'Status update failed' }); }
    });

    app.patch('/issues/:id', verifyToken, async (req, res) => {
      try {
        const email = req.user.email;
        const updatedData = { ...req.body };
        const user = await usersCol.findOne({ email });
        const issue = await issuesCol.findOne({ _id: new ObjectId(req.params.id) });
        if (!issue) return res.status(404).send({ message: 'Issue not found' });
        if (issue.reportedBy !== email && user?.role !== 'admin')
          return res.status(403).send({ message: 'Forbidden' });
        if (updatedData.priority) updatedData.priority = updatedData.priority === 'High' ? 'High' : 'Normal';
        let timelineEntry = null;
        if (updatedData.priority === 'High' && issue.priority !== 'High') {
          timelineEntry = {
            trackingId: issue.trackingId,
            status: issue.status,
            message: 'Issue priority boosted to High via payment',
            updatedBy: email,
            updaterName: user?.name || email,
            role: user?.role || 'citizen',
            timestamp: new Date(),
          };
        }
        const { assignedStaffName, timelineMessage, ...cleanData } = updatedData;
        const updateOp = { $set: { ...cleanData, updatedAt: new Date() } };
        if (timelineEntry) updateOp.$push = { timeline: timelineEntry };
        res.send(await issuesCol.updateOne({ _id: new ObjectId(req.params.id) }, updateOp));
      } catch { res.status(500).send({ message: 'Update failed' }); }
    });

    app.delete('/issues/:id', verifyToken, async (req, res) => {
      const email = req.user.email;
      const user = await usersCol.findOne({ email });
      const issue = await issuesCol.findOne({ _id: new ObjectId(req.params.id) });
      if (!issue) return res.status(404).send({ message: 'Not found' });
      if (issue.reportedBy !== email && user?.role !== 'admin')
        return res.status(403).send({ message: 'Forbidden' });
      res.send(await issuesCol.deleteOne({ _id: new ObjectId(req.params.id) }));
    });

    app.get('/issues/:id', async (req, res) => {
      try {
        const issue = await issuesCol.findOne({ _id: new ObjectId(req.params.id) });
        if (!issue) return res.status(404).send({ message: 'Issue not found' });
        res.send(issue);
      } catch { res.status(500).send({ message: 'Failed to fetch issue' }); }
    });

    // ══════════════════════════════════════════════════════════════════════════
    //  PAYMENT ROUTES
    // ══════════════════════════════════════════════════════════════════════════

    const PLAN_AMOUNTS = { weekly: 150, monthly: 500, yearly: 4500 };

    app.post('/create-checkout-session', verifyToken, async (req, res) => {
      try {
        const { type, plan, issueID, title, amount: customAmount, successUrl, cancelUrl } = req.body;
        const email = req.user.email;
        const isPremium = type === 'premium';
        const amount = isPremium ? (PLAN_AMOUNTS[plan] || PLAN_AMOUNTS.monthly) : (customAmount || 100);
        const productName = isPremium
          ? `CityFix Premium — ${plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : 'Monthly'} Plan`
          : (title || 'CityFix Payment');
        const session = await stripe.checkout.sessions.create({
          line_items: [{ price_data: { currency: 'bdt', unit_amount: amount * 100, product_data: { name: productName } }, quantity: 1 }],
          mode: 'payment',
          metadata: { issueID: issueID || '', type: type || 'boost', plan: plan || '', userEmail: email },
          customer_email: email,
          success_url: successUrl || `${process.env.SITE_DOMAIN}/details/${issueID}?payment=success&sessionID={CHECKOUT_SESSION_ID}`,
          cancel_url: cancelUrl || `${process.env.SITE_DOMAIN}/details/${issueID}?payment=cancel`,
        });
        res.send({ url: session.url });
      } catch (err) { res.status(500).send({ message: err.message }); }
    });

    // Save payment record (idempotent)
    app.post('/payments', verifyToken, async (req, res) => {
      try {
        const email = req.user.email;
        const user = await usersCol.findOne({ email });
        if (req.body.transactionId) {
          const exists = await paymentsCol.findOne({ transactionId: req.body.transactionId });
          if (exists) return res.send({ message: 'Already recorded', insertedId: exists._id });
        }
        const result = await paymentsCol.insertOne({
          ...req.body,
          email,
          userName: user?.name || '',
          userPhoto: user?.photo || '',
          issueId: req.body.issueId ? new ObjectId(req.body.issueId) : null,
          createdAt: new Date(),
        });
        res.send(result);
      } catch { res.status(500).send({ message: 'Failed to save payment' }); }
    });

    // Premium upgrade — verify Stripe session, activate, save payment record
    app.post('/users/upgrade-premium', verifyToken, async (req, res) => {
      try {
        const email = req.user.email;
        const { sessionId } = req.body;
        
        console.log('Premium upgrade request for:', email, 'sessionId:', sessionId);
        
        if (!sessionId) {
          return res.status(400).json({ message: 'Session ID required', success: false });
        }
        
        // Check if this session was already processed
        const existingRecord = await paymentsCol.findOne({ stripeSessionId: sessionId });
        if (existingRecord) {
          console.log('Session already processed:', sessionId);
          // Still make sure user is marked as premium
          await usersCol.updateOne(
            { email }, 
            { $set: { isPremium: true, premiumSince: new Date() } }
          );
          return res.json({ message: 'Premium already activated', success: true, alreadyProcessed: true });
        }
        
        // Retrieve the Stripe session
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        console.log('Stripe session status:', session.payment_status);
        
        if (session.payment_status !== 'paid') {
          return res.status(400).json({ message: 'Payment not confirmed', success: false });
        }
        
        if (session.customer_email !== email) {
          return res.status(403).json({ message: 'Email mismatch', success: false });
        }
        
        // Get user info
        const user = await usersCol.findOne({ email });
        
        // Save payment record
        await paymentsCol.insertOne({
          email,
          userName: user?.name || '',
          userPhoto: user?.photo || '',
          amount: session.amount_total / 100,
          transactionId: session.payment_intent,
          stripeSessionId: sessionId,
          purpose: `Premium — ${(session.metadata?.plan || 'monthly').charAt(0).toUpperCase() + (session.metadata?.plan || 'monthly').slice(1)} Plan`,
          type: 'premium',
          plan: session.metadata?.plan || 'monthly',
          createdAt: new Date(),
        });
        
        // Update user premium status
        await usersCol.updateOne(
          { email }, 
          { $set: { isPremium: true, premiumSince: new Date(), premiumPlan: session.metadata?.plan || 'monthly' } }
        );
        
        console.log('Premium activated for:', email);
        
        // Return success
        res.json({ 
          message: 'Premium activated successfully', 
          success: true,
          premium: true,
          plan: session.metadata?.plan || 'monthly'
        });
      } catch (err) { 
        console.error('Premium activation error:', err);
        res.status(500).json({ message: err.message, success: false }); 
      }
    });

    app.get('/payments/my', verifyToken, async (req, res) => {
      try {
        const { limit = 10, skip = 0 } = req.query;
        const email = req.user.email;
        const result = await paymentsCol
          .find({ $or: [{ email }, { paidByEmail: email }] })
          .sort({ createdAt: -1 }).skip(Number(skip)).limit(Number(limit)).toArray();
        res.send(result);
      } catch { res.status(500).send({ message: 'Failed' }); }
    });

    app.get('/payments', verifyToken, async (req, res) => {
      try {
        const { limit = 20, skip = 0 } = req.query;
        const email = req.user.email;
        const user = await usersCol.findOne({ email });
        if (user?.role === 'admin') {
          const result = await paymentsCol.aggregate([
            { $sort: { createdAt: -1 } },
            { $skip: Number(skip) }, { $limit: Number(limit) },
            { $lookup: { from: 'users', localField: 'email', foreignField: 'email', as: 'userInfo' } },
            {
              $addFields: {
                userName: {
                  $cond: {
                    if: { $and: [{ $ifNull: ['$userName', false] }, { $ne: ['$userName', ''] }] },
                    then: '$userName',
                    else: { $ifNull: [{ $arrayElemAt: ['$userInfo.name', 0] }, '$email'] },
                  },
                },
                userPhoto: {
                  $cond: {
                    if: { $ifNull: ['$userPhoto', false] }, then: '$userPhoto',
                    else: { $ifNull: [{ $arrayElemAt: ['$userInfo.photo', 0] }, ''] },
                  },
                },
              },
            },
            { $project: { userInfo: 0 } },
          ]).toArray();
          return res.send(result);
        }
        res.send(await paymentsCol.find({ $or: [{ email }, { paidByEmail: email }] }).sort({ createdAt: -1 }).skip(Number(skip)).limit(Number(limit)).toArray());
      } catch { res.status(500).send({ message: 'Failed' }); }
    });

    // ══════════════════════════════════════════════════════════════════════════
    //  DASHBOARD STATS
    // ══════════════════════════════════════════════════════════════════════════

    app.get('/dashboard/admin-stats', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const [total, resolved, pending, rejected, inProgress, paymentAgg, latestIssues] = await Promise.all([
          issuesCol.countDocuments(),
          issuesCol.countDocuments({ status: 'Resolved' }),
          issuesCol.countDocuments({ status: 'Pending' }),
          issuesCol.countDocuments({ status: 'Rejected' }),
          issuesCol.countDocuments({ status: 'In Progress' }),
          paymentsCol.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]).toArray(),
          issuesCol.find().sort({ createdAt: -1 }).limit(5).toArray(),
        ]);
        res.send({ total, resolved, pending, rejected, inProgress, totalPaymentAmount: paymentAgg[0]?.total || 0, latestIssues });
      } catch { res.status(500).send({ message: 'Failed' }); }
    });

    app.get('/dashboard/citizen-stats', verifyToken, async (req, res) => {
      try {
        const email = req.user.email;
        const [total, pending, inProgress, resolved, payments, recentIssues] = await Promise.all([
          issuesCol.countDocuments({ reportedBy: email }),
          issuesCol.countDocuments({ reportedBy: email, status: 'Pending' }),
          issuesCol.countDocuments({ reportedBy: email, status: 'In Progress' }),
          issuesCol.countDocuments({ reportedBy: email, status: 'Resolved' }),
          paymentsCol.find({ $or: [{ email }, { paidByEmail: email }] }).toArray(),
          issuesCol.find({ reportedBy: email }).sort({ createdAt: -1 }).limit(5).toArray(),
        ]);
        res.send({ total, pending, inProgress, resolved, totalPayments: payments.length, recentIssues });
      } catch { res.status(500).send({ message: 'Failed' }); }
    });

    app.get('/dashboard/staff-stats', verifyToken, verifyAdminOrStaff, async (req, res) => {
      try {
        const email = req.user.email;
        const ratingAgg = await ratingsCol.aggregate([{ $match: { staffEmail: email } }, { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }]).toArray();
        const [assigned, resolved, inProgress, pending, recentIssues] = await Promise.all([
          issuesCol.countDocuments({ assignedTo: email }),
          issuesCol.countDocuments({ assignedTo: email, status: 'Resolved' }),
          issuesCol.countDocuments({ assignedTo: email, status: 'In Progress' }),
          issuesCol.countDocuments({ assignedTo: email, status: 'Pending' }),
          issuesCol.find({ assignedTo: email }).sort({ updatedAt: -1 }).limit(5).toArray(),
        ]);
        res.send({ assigned, resolved, inProgress, pending, recentIssues, avgRating: ratingAgg[0]?.avg || 0, ratingCount: ratingAgg[0]?.count || 0 });
      } catch { res.status(500).send({ message: 'Failed' }); }
    });

    await client.db('admin').command({ ping: 1 });
    console.log('✅ Connected to MongoDB');
  } finally { /* keep alive */ }
}

run().catch(console.dir);
app.listen(port, () => console.log(`City Fixer running on port ${port}`));