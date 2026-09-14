const express = require('express');
const { MongoClient } = require('mongodb');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// رابط الاتصال بقاعدة البيانات السحابية (استبدل username و password بالبيانات الحقيقية بتاعتك)
const uri = "mongodb+srv://bodacpm:112003Ab@cluster3.oqbrc.mongodb.net/?retryWrites=true&w=majority&appName=Cluster3";
const client = new MongoClient(uri);

let db, playersCollection;

async function connectDB() {
    try {
        await client.connect();
        db = client.db("talabat_game"); // اسم قاعدة البيانات
        playersCollection = db.collection("players");
        console.log("Connected successfully to MongoDB Atlas!");
    } catch (e) {
        console.error("Failed to connect to MongoDB", e);
    }
}
connectDB();

// جلب اللاعبين من السحابة
app.get('/api/players', async (req, res) => {
    try {
        if (!playersCollection) return res.json([]);
        const players = await playersCollection.find({}).toArray();
        res.json(players);
    } catch (e) {
        res.status(500).json({ error: "Error fetching players" });
    }
});

// حفظ أو تحديث اللاعب في السحابة
app.post('/api/players', async (req, res) => {
    const { name, balance, rating } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    try {
        await playersCollection.updateOne(
            { name: name },
            { $set: { balance, rating, updatedAt: new Date() } },
            { upsert: true } // لو اللاعب مش موجود هيضيفه، ولو موجود هيحدث بياناته
        );

        const players = await playersCollection.find({}).toArray();
        res.json({ success: true, players });
    } catch (e) {
        res.status(500).json({ error: "Error saving player data" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
