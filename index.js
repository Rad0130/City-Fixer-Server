const express = require('express');
const cors = require('cors');
require('dotenv').config();
const app = express();
const stripe = require('stripe')(process.env.STRIPE_KEY);
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require('firebase-admin');

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.dm5zycv.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Firebase Admin Init ───────────────────────────────────────────────────────
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

// ── Token Verification Middleware ─────────────────────────────────────────────
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send({ message: 'Unauthorized - no token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    console.error('Token verification error:', err.message);
    return res.status(401).send({ message: 'Unauthorized - invalid token' });
  }
};

// ── Role Middleware ───────────────────────────────────────────────────────────
const verifyAdmin = async (req, res, next) => {
  try {
    const db = client.db('cityFixerDB');
    const user = await db.collection('users').findOne({ email: req.user.email });
    if (!user || user.role !== 'admin') {
      return res.status(403).send({ message: 'Forbidden - admin only' });
    }
    next();
  } catch (err) {
    res.status(500).send({ message: 'Server error in role check' });
  }
};

const verifyAdminOrStaff = async (req, res, next) => {
  try {
    const db = client.db('cityFixerDB');
    const user = await db.collection('users').findOne({ email: req.user.email });
    if (!user || !['admin', 'staff'].includes(user.role)) {
      return res.status(403).send({ message: 'Forbidden' });
    }
    next();
  } catch (err) {
    res.status(500).send({ message: 'Server error in role check' });
  }
};

// ── Tracking ID ───────────────────────────────────────────────────────────────
const getNextTrackingId = async (db) => {
  const result = await db.collection('counters').findOneAndUpdate(
    { _id: 'issueTracking' },
    { $inc: { sequence_value: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const sequence = result.sequence_value;
  const year = new Date().getFullYear();
  return `CF-${year}-${sequence.toString().padStart(5, '0')}`;
};

app.get('/', (req, res) => res.send('City Fixer Server is running'));

async function run() {
  try {
    await client.connect();

    const db = client.db('cityFixerDB');
    const issuesCollection = db.collection('issues');
    const paymentsCollection = db.collection('payments');
    const usersCollection = db.collection('users');

    // ══════════════════════════════════════════════════════════════════════════
    //  USER ROUTES
    // ══════════════════════════════════════════════════════════════════════════

    // PUBLIC — save/upsert user on register/login (no token required)
    app.post('/users', async (req, res) => {
      try {
        const { email, name, photo } = req.body;
        if (!email) return res.status(400).send({ message: 'Email required' });

        const existing = await usersCollection.findOne({ email });
        if (existing) {
          // update name/photo only, preserve role & flags
          await usersCollection.updateOne(
            { email },
            { $set: { name: name || existing.name, photo: photo || existing.photo } }
          );
          return res.send({ message: 'User updated', role: existing.role });
        }

        const newUser = {
          email,
          name: name || '',
          photo: photo || '',
          role: 'citizen',
          isBlocked: false,
          isPremium: false,
          createdAt: new Date(),
        };
        const result = await usersCollection.insertOne(newUser);
        res.send(result);
      } catch (err) {
        console.error('POST /users error:', err);
        res.status(500).send({ message: 'Server error' });
      }
    });

    // Get my role/info
    app.get('/users/me', verifyToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.user.email });
      if (!user) return res.status(404).send({ message: 'User not found' });
      res.send(user);
    });

    // Get role by email (only same user can call)
    app.get('/users/role/:email', verifyToken, async (req, res) => {
      if (req.user.email !== req.params.email) {
        return res.status(403).send({ message: 'Forbidden' });
      }
      const user = await usersCollection.findOne({ email: req.params.email });
      res.send({
        role: user?.role || 'citizen',
        isBlocked: user?.isBlocked || false,
        isPremium: user?.isPremium || false,
      });
    });

    // Admin: get all citizens
    app.get('/users/citizens', verifyToken, verifyAdmin, async (req, res) => {
      const users = await usersCollection.find({ role: 'citizen' }).sort({ createdAt: -1 }).toArray();
      res.send(users);
    });

    // Admin: get all staff
    app.get('/users/staff', verifyToken, verifyAdmin, async (req, res) => {
      const users = await usersCollection.find({ role: 'staff' }).sort({ createdAt: -1 }).toArray();
      res.send(users);
    });

    // Admin: block/unblock
    app.patch('/users/:email/block', verifyToken, verifyAdmin, async (req, res) => {
      const { isBlocked } = req.body;
      const result = await usersCollection.updateOne(
        { email: req.params.email },
        { $set: { isBlocked } }
      );
      res.send(result);
    });

    // Admin: change role
    app.patch('/users/:email/role', verifyToken, verifyAdmin, async (req, res) => {
      const { role } = req.body;
      const result = await usersCollection.updateOne(
        { email: req.params.email },
        { $set: { role } }
      );
      res.send(result);
    });

    // Admin: create staff (Firebase + DB)
    app.post('/users/staff', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { name, email, phone, photo, password } = req.body;
        const firebaseUser = await admin.auth().createUser({
          email, password, displayName: name, photoURL: photo || '',
        });

        const existing = await usersCollection.findOne({ email });
        if (existing) {
          await usersCollection.updateOne({ email }, { $set: { name, photo, phone, role: 'staff' } });
        } else {
          await usersCollection.insertOne({
            email, name, photo: photo || '', phone: phone || '',
            role: 'staff', isBlocked: false, isPremium: false, createdAt: new Date(),
          });
        }
        res.send({ message: 'Staff created', uid: firebaseUser.uid });
      } catch (err) {
        console.error('Create staff error:', err);
        res.status(500).send({ message: err.message });
      }
    });

    // Admin: update staff
    app.patch('/users/staff/:email', verifyToken, verifyAdmin, async (req, res) => {
      const { name, phone, photo } = req.body;
      const result = await usersCollection.updateOne(
        { email: req.params.email },
        { $set: { name, phone, photo } }
      );
      res.send(result);
    });

    // Admin: delete staff
    app.delete('/users/staff/:email', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const fbUser = await admin.auth().getUserByEmail(req.params.email);
        await admin.auth().deleteUser(fbUser.uid);
      } catch (_) {
        // Firebase user may not exist, continue
      }
      const result = await usersCollection.deleteOne({ email: req.params.email });
      res.send(result);
    });

    // Make user premium
    app.patch('/users/me/premium', verifyToken, async (req, res) => {
      const result = await usersCollection.updateOne(
        { email: req.user.email },
        { $set: { isPremium: true } }
      );
      res.send(result);
    });

    // ══════════════════════════════════════════════════════════════════════════
    //  ISSUE ROUTES
    // ══════════════════════════════════════════════════════════════════════════

    // Create issue
    app.post('/issues', verifyToken, async (req, res) => {
      try {
        const email = req.user.email;
        const user = await usersCollection.findOne({ email });

        if (user?.isBlocked) {
          return res.status(403).send({ message: 'You are blocked from reporting issues.' });
        }

        if (!user?.isPremium) {
          const myCount = await issuesCollection.countDocuments({ reportedBy: email });
          if (myCount >= 3) {
            return res.status(403).send({ message: 'Free limit reached. Subscribe to report more.' });
          }
        }

        const newIssue = {
          ...req.body,
          trackingId: await getNextTrackingId(db),
          createdAt: new Date(),
          timeline: [
            {
              status: req.body.status || 'Pending',
              message: 'Issue reported by citizen',
              updatedBy: email,
              role: 'citizen',
              timestamp: new Date(),
            },
          ],
        };

        const result = await issuesCollection.insertOne(newIssue);
        res.send(result);
      } catch (err) {
        console.error('POST /issues error:', err);
        res.status(500).send({ message: 'Failed to create issue' });
      }
    });

    // Get issues (public, with filters)
    app.get('/issues', async (req, res) => {
      try {
        const { status, priority, category, search, limit, skip, _id, reportedBy, assignedTo } = req.query;
        let query = {};

        if (_id) query._id = new ObjectId(_id);
        if (reportedBy) query.reportedBy = reportedBy;
        if (assignedTo) query.assignedTo = assignedTo;
        if (status) query.status = { $in: status.split(',') };
        if (priority) query.priority = { $in: priority.split(',') };
        if (category) query.category = { $in: category.split(',') };
        if (search) {
          query.$or = [
            { title: { $regex: search, $options: 'i' } },
            { category: { $regex: search, $options: 'i' } },
            { location: { $regex: search, $options: 'i' } },
          ];
        }

        const result = await issuesCollection.aggregate([
          { $match: query },
          {
            $addFields: {
              priorityOrder: {
                $switch: {
                  branches: [
                    { case: { $eq: ['$priority', 'High'] }, then: 1 },
                    { case: { $eq: ['$priority', 'Normal'] }, then: 2 },
                    { case: { $eq: ['$priority', 'Low'] }, then: 3 },
                  ],
                  default: 4,
                },
              },
            },
          },
          { $sort: { priorityOrder: 1, _id: -1 } },
          { $skip: Number(skip) || 0 },
          { $limit: Number(limit) || 10 },
        ]).toArray();

        res.send(result);
      } catch (err) {
        console.error('GET /issues error:', err);
        res.status(500).send({ message: 'Failed to fetch issues' });
      }
    });

    // Resolved issues for home page (public)
    app.get('/issues/resolved', async (req, res) => {
      const result = await issuesCollection
        .find({ status: 'Resolved' })
        .sort({ createdAt: -1 })
        .limit(6)
        .toArray();
      res.send(result);
    });

    // Count issues (public)
    app.get('/issues/count', async (req, res) => {
      const { status, priority, category, search, reportedBy, assignedTo } = req.query;
      let query = {};
      if (reportedBy) query.reportedBy = reportedBy;
      if (assignedTo) query.assignedTo = assignedTo;
      if (status) query.status = { $in: status.split(',') };
      if (priority) query.priority = { $in: priority.split(',') };
      if (category) query.category = { $in: category.split(',') };
      if (search) {
        query.$or = [
          { title: { $regex: search, $options: 'i' } },
          { category: { $regex: search, $options: 'i' } },
          { location: { $regex: search, $options: 'i' } },
        ];
      }
      const count = await issuesCollection.countDocuments(query);
      res.send({ count });
    });

    // Update issue (general patch — owner edits, admin updates priority etc.)
    app.patch('/issues/:id', verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const email = req.user.email;
        const updatedData = { ...req.body };
        const user = await usersCollection.findOne({ email });
        const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });

        if (!issue) return res.status(404).send({ message: 'Issue not found' });

        // Permission check: owner OR admin can patch
        if (issue.reportedBy !== email && user?.role !== 'admin') {
          return res.status(403).send({ message: 'Forbidden' });
        }

        // Build timeline entry
        let timelineEntry = null;

        // Priority boost
        if (updatedData.priority === 'High' && issue.priority !== 'High') {
          timelineEntry = {
            status: issue.status,
            message: 'Issue priority boosted to High via citizen payment',
            updatedBy: email,
            role: user?.role || 'citizen',
            timestamp: new Date(),
          };
        }

        // Staff assignment (from admin)
        if (updatedData.assignedTo && !issue.assignedTo) {
          timelineEntry = {
            status: issue.status,
            message: `Issue assigned to staff: ${updatedData.assignedStaffName || updatedData.assignedTo}`,
            updatedBy: email,
            role: 'admin',
            timestamp: new Date(),
          };
        }

        // Remove helper field before saving
        const { assignedStaffName, timelineMessage, ...cleanData } = updatedData;

        const updateOp = {
          $set: { ...cleanData, updatedAt: new Date() },
        };
        if (timelineEntry) updateOp.$push = { timeline: timelineEntry };

        const result = await issuesCollection.updateOne({ _id: new ObjectId(id) }, updateOp);
        res.send(result);
      } catch (err) {
        console.error('PATCH /issues/:id error:', err);
        res.status(500).send({ message: 'Update failed' });
      }
    });

    // Upvote
    app.patch('/issues/:id/upvote', verifyToken, async (req, res) => {
      const { email } = req.body;
      const id = req.params.id;
      const result = await issuesCollection.updateOne(
        { _id: new ObjectId(id), upvotedBy: { $ne: email } },
        { $inc: { upvotes: 1 }, $push: { upvotedBy: email } }
      );
      if (result.matchedCount === 0) return res.status(409).send({ message: 'Already upvoted' });
      res.send({ message: 'Upvoted successfully' });
    });

    // Delete issue
    app.delete('/issues/:id', verifyToken, async (req, res) => {
      const id = req.params.id;
      const email = req.user.email;
      const user = await usersCollection.findOne({ email });
      const issue = await issuesCollection.findOne({ _id: new ObjectId(id) });

      if (!issue) return res.status(404).send({ message: 'Not found' });
      if (issue.reportedBy !== email && user?.role !== 'admin') {
        return res.status(403).send({ message: 'Forbidden' });
      }

      const result = await issuesCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // Admin: assign staff to issue
    app.patch('/issues/:id/assign', verifyToken, verifyAdmin, async (req, res) => {
      const { id } = req.params;
      const { staffEmail, staffName } = req.body;
      const adminEmail = req.user.email;

      const result = await issuesCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: { assignedTo: staffEmail, assignedStaffName: staffName, updatedAt: new Date() },
          $push: {
            timeline: {
              status: 'In Progress',
              message: `Issue assigned to staff: ${staffName}`,
              updatedBy: adminEmail,
              role: 'admin',
              timestamp: new Date(),
            },
          },
        }
      );
      res.send(result);
    });

    // Staff/Admin: change issue status
    app.patch('/issues/:id/status', verifyToken, verifyAdminOrStaff, async (req, res) => {
      const { id } = req.params;
      const { status, message } = req.body;
      const email = req.user.email;
      const user = await usersCollection.findOne({ email });

      const result = await issuesCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: { status, updatedAt: new Date() },
          $push: {
            timeline: {
              status,
              message: message || `Status updated to ${status}`,
              updatedBy: email,
              role: user?.role || 'staff',
              timestamp: new Date(),
            },
          },
        }
      );
      res.send(result);
    });

    // ══════════════════════════════════════════════════════════════════════════
    //  PAYMENT ROUTES
    // ══════════════════════════════════════════════════════════════════════════

    app.post('/create-checkout-session', verifyToken, async (req, res) => {
      try {
        const paymentInfo = req.body;
        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: 'bdt',
                unit_amount: (paymentInfo.amount || 100) * 100,
                product_data: { name: paymentInfo.title },
              },
              quantity: 1,
            },
          ],
          mode: 'payment',
          metadata: {
            issueID: paymentInfo.issueID || '',
            type: paymentInfo.type || 'boost',
          },
          customer_email: paymentInfo.email,
          success_url:
            paymentInfo.successUrl ||
            `${process.env.SITE_DOMAIN}/details/${paymentInfo.issueID}?payment=success&sessionID={CHECKOUT_SESSION_ID}`,
          cancel_url:
            paymentInfo.cancelUrl ||
            `${process.env.SITE_DOMAIN}/details/${paymentInfo.issueID}?payment=cancel`,
        });
        res.send({ url: session.url });
      } catch (err) {
        console.error('Stripe error:', err);
        res.status(500).send({ message: err.message });
      }
    });

    app.post('/payments', verifyToken, async (req, res) => {
      const payment = req.body;
      const paymentInformation = {
        ...payment,
        issueId: payment.issueId ? new ObjectId(payment.issueId) : null,
        createdAt: new Date(),
      };
      const result = await paymentsCollection.insertOne(paymentInformation);
      res.send(result);
    });

    // Get payments — admin gets all, citizens get their own
    app.get('/payments', verifyToken, async (req, res) => {
      const email = req.user.email;
      const user = await usersCollection.findOne({ email });
      const query = user?.role === 'admin' ? {} : { paidByEmail: email };
      const result = await paymentsCollection.find(query).sort({ createdAt: -1 }).toArray();
      res.send(result);
    });

    // ══════════════════════════════════════════════════════════════════════════
    //  DASHBOARD STATS ROUTES
    // ══════════════════════════════════════════════════════════════════════════

    app.get('/dashboard/admin-stats', verifyToken, verifyAdmin, async (req, res) => {
      const [total, resolved, pending, rejected, inProgress, paymentAgg, latestIssues, latestPayments, latestUsers] =
        await Promise.all([
          issuesCollection.countDocuments(),
          issuesCollection.countDocuments({ status: 'Resolved' }),
          issuesCollection.countDocuments({ status: 'Pending' }),
          issuesCollection.countDocuments({ status: 'Rejected' }),
          issuesCollection.countDocuments({ status: 'In Progress' }),
          paymentsCollection.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]).toArray(),
          issuesCollection.find().sort({ createdAt: -1 }).limit(5).toArray(),
          paymentsCollection.find().sort({ createdAt: -1 }).limit(5).toArray(),
          usersCollection.find({ role: 'citizen' }).sort({ createdAt: -1 }).limit(5).toArray(),
        ]);

      res.send({
        total, resolved, pending, rejected, inProgress,
        totalPaymentAmount: paymentAgg[0]?.total || 0,
        latestIssues,
        latestPayments,
        latestUsers,
      });
    });

    app.get('/dashboard/citizen-stats', verifyToken, async (req, res) => {
      const email = req.user.email;
      const [total, pending, inProgress, resolved, payments] = await Promise.all([
        issuesCollection.countDocuments({ reportedBy: email }),
        issuesCollection.countDocuments({ reportedBy: email, status: 'Pending' }),
        issuesCollection.countDocuments({ reportedBy: email, status: 'In Progress' }),
        issuesCollection.countDocuments({ reportedBy: email, status: 'Resolved' }),
        paymentsCollection.find({ paidByEmail: email }).toArray(),
      ]);
      res.send({ total, pending, inProgress, resolved, totalPayments: payments.length });
    });

    app.get('/dashboard/staff-stats', verifyToken, verifyAdminOrStaff, async (req, res) => {
      const email = req.user.email;
      const [assigned, resolved, inProgress] = await Promise.all([
        issuesCollection.countDocuments({ assignedTo: email }),
        issuesCollection.countDocuments({ assignedTo: email, status: 'Resolved' }),
        issuesCollection.countDocuments({ assignedTo: email, status: 'In Progress' }),
      ]);
      res.send({ assigned, resolved, inProgress });
    });

    await client.db('admin').command({ ping: 1 });
    console.log('Connected to MongoDB!');
  } finally {
    // keep connection open
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`City Fixer Server running on port: ${port}`);
});