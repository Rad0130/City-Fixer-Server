const express=require('express');
const cors = require('cors');
const app=express()
const port= process.env.PORT || 3000
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

//middleware
app.use(cors());
app.use(express.json());

app.get('/',(req,res)=>{
    res.send('City Fixer Server is running')
});

app.listen(port,()=>{
    console.log(`City Fixer Server is running on port: ${port}`);
});