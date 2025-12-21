const express=require('express');
const cors = require('cors');
require('dotenv').config();
const app=express()
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

app.get('/',(req,res)=>{
    res.send('City Fixer Server is running')
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db=client.db('cityFixerDB');
    const issuesCollections=db.collection('issues');

    app.post('/issues',async(req,res)=>{
        const newIssue=req.body;
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

      const cursor=issuesCollections.find(query).limit(Number(limit)).skip(Number(skip)).sort({_id:-1});
      const result=(await cursor.toArray());
      res.send(result);
    });

    //get total issues count for pageinitation
    app.get('/issues/count',async(req,res)=>{
      const count=(await issuesCollections.estimatedDocumentCount()).toString();
      res.send({count});
    })

    app.patch('/issues/:id',async(req,res)=>{
        const id=req.params.id;
        const updatedIssue=req.body;
        const query={_id:new ObjectId(id)};
        const update={
            $set:{
                upvotes:updatedIssue.upvotes
            }
        };
        const result=await issuesCollections.updateOne(query,update);
        res.send(result);
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