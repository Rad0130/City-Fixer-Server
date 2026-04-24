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

// ── AI Chatbot Route (WORKING with gemini-2.5-flash) ─────────────────────────────────────────
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

Important: Keep responses helpful, friendly, and under 200 words.`;

    // Function to call OpenRouter
    const callOpenRouter = async (userMessage) => {
      try {
        const response = await openRouterClient.post('/chat/completions', {
          model: 'google/gemini-2.0-flash-exp:free', // Free tier model
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

    // If both fail, provide helpful fallback responses
    if (!reply || reply.trim() === '') {
      // Check for common question patterns and provide specific answers
      const lowerMessage = message.toLowerCase();
      
      if (lowerMessage.includes('how to report') || lowerMessage.includes('submit issue')) {
        reply = "📝 To report an issue:\n\n1. Log in to your account\n2. Click '+ Report Issue' on your dashboard\n3. Fill in title, category, location, and description\n4. Upload a photo (optional but helpful)\n5. Click 'Submit'\n\nYou'll receive a tracking ID like CF-2025-00001 to track your issue! 🎯";
      } 
      else if (lowerMessage.includes('premium') || lowerMessage.includes('upgrade')) {
        reply = "⭐ **Premium Plans:**\n\n• Weekly: ৳150/week\n• Monthly: ৳500/month (most popular)\n• Yearly: ৳4,500/year (save 25%)\n\n**Benefits:** Unlimited reports, priority support, and early access to features!\n\nGo to Dashboard → Profile → 'Upgrade to Premium' to subscribe. 💎";
      }
      else if (lowerMessage.includes('track') || lowerMessage.includes('status')) {
        reply = "🔍 You can track your issues by:\n\n1. Going to your Dashboard\n2. Clicking 'My Issues'\n3. Entering your tracking ID (e.g., CF-2025-00001)\n\nStatuses include: Pending → In Progress → Resolved → Closed.\n\nNeed help? Check your email for updates too! 📧";
      }
      else if (lowerMessage.includes('staff') || lowerMessage.includes('become staff')) {
        reply = "👨‍🔧 To become a staff member:\n\n1. Go to Dashboard → Profile\n2. Scroll to 'Become Staff' section\n3. Write why you want to join\n4. Submit your request\n\nAdmin will review and if approved, you'll get staff access to fix issues in your community! 🌟";
      }
      else if (lowerMessage.includes('admin') || lowerMessage.includes('administrator')) {
        reply = "👑 **Admin Capabilities:**\n\n• View platform statistics\n• Manage all users (verify, ban, role changes)\n• Assign issues to staff\n• Approve staff requests\n• View all payments\n• Delete/edit any content\n\nAdmins have full access to keep CityFix running smoothly! 🔧";
      }
      else if (lowerMessage.includes('price') || lowerMessage.includes('cost') || lowerMessage.includes('payment')) {
        reply = "💳 **Payments on CityFix:**\n\n• Premium plans start from ৳150/week\n• Pay securely via Stripe\n• One-time payment, no auto-renewal\n• Boost priority: ৳100 to mark issue as High Priority\n\nAll payments are secure and processed through Stripe. Questions? Contact support@cityfix.com 💰";
      }
      else if (lowerMessage.includes('category') || lowerMessage.includes('type of issue')) {
        reply = "📂 **Available Categories (28 total):**\n\nRoads & Pavements, Street Lights, Drainage, Garbage & Sanitation, Parks & Gardens, Water Supply, Public Transport, Electricity, Building Violations, Pollution, Public Safety, Healthcare, Education Infrastructure, Digital Services, Animal Control, Fire Safety, Mosquito Control, Noise Pollution, Traffic Signals, Sidewalks, Bridges & Flyovers, Public Toilets, Markets & Hawkers, Solid Waste Management, Sewage System, Playgrounds, Community Centers, and Others.\n\nSelect the one that best matches your issue! 🏙️";
      }
      else if (lowerMessage.includes('hello') || lowerMessage.includes('hi') || lowerMessage.includes('hey')) {
        reply = `Hello ${userName}! 👋 Welcome to CityFix Assistant. I'm here to help you with reporting and tracking civic issues. How can I assist you today? 🏙️`;
      }
      else {
        reply = "I'm here to help with CityFix platform! 🤖 You can ask me about:\n\n• How to report issues 📝\n• Premium membership plans ⭐\n• Tracking your issues 🔍\n• Becoming a staff member 👨‍🔧\n• Platform features and pricing 💰\n\nWhat would you like to know? 😊\n\n*Note: Some AI features are temporarily offline. Contact support@cityfix.com for urgent help.*";
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
        if (!user?.isPremium && await issuesCol.countDocuments({ reportedBy: email }) >= 3) {
          return res.status(403).send({ message: 'Free limit reached. Upgrade to Premium to report more.' });
        }
        const priority = req.body.priority === 'High' ? 'High' : 'Normal';
        const trackingId = await getNextTrackingId(db);
        const result = await issuesCol.insertOne({
          ...req.body,
          priority,
          trackingId,
          reportedBy: email,
          reporterName: user?.name || '',
          reporterPhoto: user?.photo || '',
          upvotes: 0,
          upvotedBy: [],
          createdAt: new Date(),
          status: 'Pending',
          timeline: [{
            trackingId,
            status: 'Pending',
            message: 'Issue reported by citizen',
            updatedBy: email,
            updaterName: user?.name || email,
            role: 'citizen',
            timestamp: new Date(),
          }],
        });
        res.send(result);
      } catch { res.status(500).send({ message: 'Failed to create issue' }); }
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
        const result = await issuesCol.aggregate([
          { $match: query },
          { $addFields: { priorityOrder: { $cond: [{ $eq: ['$priority', 'High'] }, 1, 2] } } },
          { $sort: { priorityOrder: 1, _id: -1 } },
          { $skip: Number(skip) || 0 },
          { $limit: Number(limit) || 10 },
        ]).toArray();
        res.send(result);
      } catch { res.status(500).send({ message: 'Failed to fetch issues' }); }
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