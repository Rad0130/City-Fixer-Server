const express=require('express');
const cors = require('cors');
require('dotenv').config();
const app=express()
const stripe = require('stripe')(process.env.STRIPE_KEY);
const port= process.env.PORT || 3000
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.dm5zycv.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

//middleware
app.use(cors());
app.use(express.json());

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


app.get('/',(req,res)=>{
    res.send('City Fixer Server is running')
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db=client.db('cityFixerDB');
    const issuesCollections=db.collection('issues');
    const paymentsCollection=db.collection('payments')

    app.post('/issues',async(req,res)=>{
        const newIssue={
          ...req.body,
          trackingId: await getNextTrackingId(db),
          createdAt:new Date()
        };
        const result=await issuesCollections.insertOne(newIssue);
        res.send(result);
    });

    //latest issues
    app.get('/issues',async(req,res)=>{
      const {status, priority, category, search, limit, skip, _id}=req.query;
      let query={};

      if(_id){
        query._id=new ObjectId(_id);
      }

      if(status){
        query.status={$in:status.split(',')};
      };
      if(priority){
        query.priority={$in:priority.split(',')};
      };
      if(category){
        query.category={$in:category.split(',')};
      };

      if(search){
        query.$or=[
          {title:{$regex:search,$options:'i'}},
          {category:{$regex:search,$options:'i'}},
          {location:{$regex:search,$options:'i'}}
        ];
      }

      const result = await issuesCollections.aggregate([
        { $match: query },
        {
          $addFields: {
            priorityOrder: {
              $switch: {
                branches: [
                  { case: { $eq: ['$priority', 'High'] }, then: 1 },
                  { case: { $eq: ['$priority', 'Medium'] }, then: 2 },
                  { case: { $eq: ['$priority', 'Low'] }, then: 3 }
                ],
                default: 4
              }
            }
          }
        },
        { $sort: { priorityOrder: 1, _id: -1 } },
        { $skip: Number(skip) || 0 },
        { $limit: Number(limit) || 10 }
      ]).toArray();
      res.send(result);
    });

    app.get('/issues/resolved', async (req, res) => {
      const result = await issuesCollections
        .find({ status: "Resolved" })
        .sort({ createdAt: -1 })
        .limit(6)
        .toArray();

      res.send(result);
    });


    //get total issues count for pageinitation
    app.get('/issues/count',async(req,res)=>{
      const count=(await issuesCollections.estimatedDocumentCount()).toString();
      res.send({count});
    })

    app.patch('/issues/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const updatedData = req.body;

        const result = await issuesCollections.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              ...updatedData,
              updatedAt: new Date()
            }
          }
        );

        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Update failed" });
      }
    });

    app.patch('/issues/:id/upvote', async (req, res) => {
    const { email } = req.body;
    const id = req.params.id;

    const result = await issuesCollections.updateOne(
      {
        _id: new ObjectId(id),
        upvotedBy: { $ne: email }
      },
      {
        $inc: { upvotes: 1 },
        $push: { upvotedBy: email }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(409).send({ message: 'Already upvoted' });
    }

    res.send({ message: 'Upvoted successfully' });
  });


    app.delete('/issues/:id',async(req,res)=>{
        const id=req.params.id;
        const filter={_id:new ObjectId(id)};
        const result=await issuesCollections.deleteOne(filter);
        res.send(result);
    });

    //payment gateway
    app.post('/create-checkout-session', async(req,res)=>{
      const paymentInfo=req.body;
      const session=await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data:{
              currency:'bdt',
              unit_amount:10000,
              product_data:{
                name: paymentInfo.title
              }
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        metadata:{
            issueID: paymentInfo.issueID
        },
        customer_email:paymentInfo.email,
        success_url: `${process.env.SITE_DOMAIN}/details/${paymentInfo.issueID}?payment=success&sessionID={CHECKOUT_SESSION_ID}`,
        cancel_url:`${process.env.SITE_DOMAIN}/details/${paymentInfo.issueID}?payment=cancel`
      });
      res.send({ url: session.url })
    });

    app.post('/payments', async(req,res)=>{
      const payment=req.body;

      const paymentInformation={
        ...payment,
        issueId:new ObjectId(payment.issueId),
        createdAt:new Date()
      };

      const result = await paymentsCollection.insertOne(paymentInformation);
      res.send(result);

    });

    app.get('/payments', async(req,res)=>{
      const result= await paymentsCollection.find().sort({createdAt:-1}).toArray();
      res.send(result);
    })
    

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port,()=>{
    console.log(`City Fixer Server is running on port: ${port}`);
});