const express = require("express");
const http = require("http");
const path = require("path");
const { MongoClient } = require("mongodb");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ===============================
// MongoDB
// ===============================

const MONGODB_URI = process.env.MONGODB_URI || "";

let client;
let db;

let playersCollection;
let missionsCollection;
let settingsCollection;

// ===============================
// Express
// ===============================

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, ".")));

// ===============================
// Database
// ===============================

async function connectDB() {
    if (!MONGODB_URI) {
        console.error("❌ MONGODB_URI is not configured.");
        return;
    }

    try {
        client = new MongoClient(MONGODB_URI);

        await client.connect();

        db = client.db("talabat_game");

        playersCollection = db.collection("players");
        missionsCollection = db.collection("missions");
        settingsCollection = db.collection("settings");

        await playersCollection.createIndex(
            { playerId: 1 },
            { unique: true, sparse: true }
        );

        await playersCollection.createIndex({ name: 1 });

        await missionsCollection.createIndex(
            { id: 1 },
            { unique: true, sparse: true }
        );

        console.log("✅ Connected to MongoDB successfully!");
    } catch (error) {
        console.error("❌ MongoDB connection failed:");
        console.error(error);
    }
}

// ===============================
// Helpers
// ===============================

function cleanNumber(value, fallback = 0) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return fallback;
    }

    return number;
}

function cleanString(value, fallback = "") {
    if (typeof value !== "string") {
        return fallback;
    }

    return value.trim();
}

function cleanRiders(riders) {
    if (!Array.isArray(riders)) {
        return [];
    }

    return riders.slice(0, 100).map((rider, index) => ({
        id: rider.id ?? index + 1,
        name: cleanString(rider.name, `كابتن ${index + 1}`),
        speedMs: cleanNumber(rider.speedMs, 12000),
        salaryCost: cleanNumber(rider.salaryCost, 30),
        status: cleanString(rider.status, "متاح"),
        vehicle: cleanString(rider.vehicle, "موتوسيكل"),
        ordersLeft: cleanNumber(rider.ordersLeft, 10)
    }));
}

function cleanPlayerData(body) {
    const playerId = cleanString(body.playerId);
    const name = cleanString(body.name);

    if (!playerId) {
        throw new Error("playerId is required");
    }

    if (!name) {
        throw new Error("name is required");
    }

    return {
        playerId,
        name,

        balance: cleanNumber(body.balance, 500),
        totalRevenue: cleanNumber(body.totalRevenue, 0),
        taxDue: cleanNumber(body.taxDue, 0),

        rating: cleanNumber(body.rating, 4.8),

        level: cleanNumber(body.level, 1),
        xp: cleanNumber(body.xp, 0),
        maxXp: cleanNumber(body.maxXp, 100),

        maxFleetSize: cleanNumber(body.maxFleetSize, 3),
        officeLevel: cleanNumber(body.officeLevel, 1),

        hasBoxUpgrade: Boolean(body.hasBoxUpgrade),

        riders: cleanRiders(body.riders),

        updatedAt: new Date()
    };
}

function cleanMission(body) {
    return {
        id: body.id || Date.now(),

        title: cleanString(body.title, "مهمة جديدة"),

        rewardMoney: cleanNumber(body.rewardMoney, 0),

        rewardXp: cleanNumber(body.rewardXp, 40),

        target: Math.max(
            1,
            cleanNumber(body.target, 1)
        ),

        createdAt: new Date()
    };
}

async function getAllPlayers() {
    if (!playersCollection) {
        return [];
    }

    return await playersCollection
        .find({})
        .sort({ balance: -1 })
        .limit(500)
        .toArray();
}

// ===============================
// HEALTH
// ===============================

app.get("/api/health", async (req, res) => {
    res.json({
        success: true,
        server: "Talabat Tycoon Pro",
        mongodb: Boolean(db),
        time: new Date().toISOString()
    });
});

// ===============================
// PLAYERS
// ===============================

app.get("/api/players", async (req, res) => {
    try {
        if (!playersCollection) {
            return res.json([]);
        }

        const players = await getAllPlayers();

        res.json(players);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Error fetching players"
        });
    }
});

app.get("/api/players/id/:playerId", async (req, res) => {
    try {
        if (!playersCollection) {
            return res.status(503).json({
                error: "Database unavailable"
            });
        }

        const player = await playersCollection.findOne({
            playerId: req.params.playerId
        });

        if (!player) {
            return res.status(404).json({
                error: "Player not found"
            });
        }

        res.json(player);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Error fetching player"
        });
    }
});

app.get("/api/players/:name", async (req, res) => {
    try {
        if (!playersCollection) {
            return res.status(503).json({
                error: "Database unavailable"
            });
        }

        const name = decodeURIComponent(req.params.name);

        let player = await playersCollection.findOne({
            playerId: name
        });

        if (!player) {
            player = await playersCollection.findOne({
                name
            });
        }

        if (!player) {
            return res.status(404).json({
                error: "Player not found"
            });
        }

        res.json(player);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Error fetching player"
        });
    }
});

// ===============================
// SAVE PLAYER
// ===============================

app.post("/api/players", async (req, res) => {
    try {
        if (!playersCollection) {
            return res.status(503).json({
                success: false,
                error: "Database unavailable"
            });
        }

        const player = cleanPlayerData(req.body);

        await playersCollection.updateOne(
            {
                playerId: player.playerId
            },
            {
                $set: player
            },
            {
                upsert: true
            }
        );

        const players = await getAllPlayers();

        io.emit("leaderboard:update", players);

        io.emit("player:update", player);

        res.json({
            success: true,
            player,
            players
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message || "Error saving player"
        });
    }
});

// ===============================
// ADMIN - PLAYER MANAGEMENT
// ===============================

// إضافة فلوس
app.post("/api/admin/give-money", async (req, res) => {
    try {
        if (!playersCollection) {
            return res.status(503).json({
                success: false,
                error: "Database unavailable"
            });
        }

        const playerId = cleanString(req.body.playerId);
        const amount = cleanNumber(req.body.amount, 0);

        if (!playerId || amount <= 0) {
            return res.status(400).json({
                success: false,
                error: "Invalid player or amount"
            });
        }

        const result = await playersCollection.findOneAndUpdate(
            {
                playerId
            },
            {
                $inc: {
                    balance: amount
                },
                $set: {
                    updatedAt: new Date()
                }
            },
            {
                returnDocument: "after"
            }
        );

        if (!result.value) {
            return res.status(404).json({
                success: false,
                error: "Player not found"
            });
        }

        const players = await getAllPlayers();

        io.emit("leaderboard:update", players);
        io.emit("player:update", result.value);

        res.json({
            success: true,
            player: result.value
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: "Error adding money"
        });
    }
});

// تحديد الرصيد
app.post("/api/admin/set-balance", async (req, res) => {
    try {
        if (!playersCollection) {
            return res.status(503).json({
                success: false,
                error: "Database unavailable"
            });
        }

        const playerId = cleanString(req.body.playerId);
        const balance = Math.max(
            0,
            cleanNumber(req.body.balance, 0)
        );

        const result = await playersCollection.findOneAndUpdate(
            {
                playerId
            },
            {
                $set: {
                    balance,
                    updatedAt: new Date()
                }
            },
            {
                returnDocument: "after"
            }
        );

        if (!result.value) {
            return res.status(404).json({
                success: false,
                error: "Player not found"
            });
        }

        io.emit(
            "leaderboard:update",
            await getAllPlayers()
        );

        io.emit(
            "player:update",
            result.value
        );

        res.json({
            success: true,
            player: result.value
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: "Error setting balance"
        });
    }
});

// تحديد المستوى
app.post("/api/admin/set-level", async (req, res) => {
    try {
        if (!playersCollection) {
            return res.status(503).json({
                success: false,
                error: "Database unavailable"
            });
        }

        const playerId = cleanString(req.body.playerId);

        const level = Math.max(
            1,
            cleanNumber(req.body.level, 1)
        );

        const result = await playersCollection.findOneAndUpdate(
            {
                playerId
            },
            {
                $set: {
                    level,
                    updatedAt: new Date()
                }
            },
            {
                returnDocument: "after"
            }
        );

        if (!result.value) {
            return res.status(404).json({
                success: false,
                error: "Player not found"
            });
        }

        io.emit(
            "player:update",
            result.value
        );

        res.json({
            success: true,
            player: result.value
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: "Error setting level"
        });
    }
});

// ===============================
// MISSIONS
// ===============================

app.get("/api/missions", async (req, res) => {
    try {
        if (!missionsCollection) {
            return res.json([]);
        }

        const missions = await missionsCollection
            .find({})
            .sort({
                createdAt: -1
            })
            .limit(100)
            .toArray();

        res.json(missions);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Error fetching missions"
        });
    }
});

app.post("/api/missions", async (req, res) => {
    try {
        if (!missionsCollection) {
            return res.status(503).json({
                success: false,
                error: "Database unavailable"
            });
        }

        const mission = cleanMission(req.body);

        await missionsCollection.insertOne(mission);

        io.emit(
            "mission:new",
            mission
        );

        res.json({
            success: true,
            mission
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: "Error creating mission"
        });
    }
});

app.delete("/api/missions/:missionId", async (req, res) => {
    try {
        if (!missionsCollection) {
            return res.status(503).json({
                success: false,
                error: "Database unavailable"
            });
        }

        const missionId = Number(
            req.params.missionId
        );

        await missionsCollection.deleteOne({
            id: missionId
        });

        io.emit(
            "mission:delete",
            missionId
        );

        res.json({
            success: true
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: "Error deleting mission"
        });
    }
});

// ===============================
// BROADCAST
// ===============================

app.get("/api/broadcast", async (req, res) => {
    try {
        if (!settingsCollection) {
            return res.json({
                text: ""
            });
        }

        const setting = await settingsCollection.findOne({
            key: "global_broadcast"
        });

        res.json({
            text: setting?.text || ""
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Error fetching broadcast"
        });
    }
});

app.post("/api/broadcast", async (req, res) => {
    try {
        if (!settingsCollection) {
            return res.status(503).json({
                success: false,
                error: "Database unavailable"
            });
        }

        const text = cleanString(
            req.body.text
        );

        if (!text) {
            return res.status(400).json({
                success: false,
                error: "Broadcast text is required"
            });
        }

        const data = {
            key: "global_broadcast",
            text,
            updatedAt: new Date()
        };

        await settingsCollection.updateOne(
            {
                key: "global_broadcast"
            },
            {
                $set: data
            },
            {
                upsert: true
            }
        );

        io.emit(
            "broadcast:new",
            text
        );

        res.json({
            success: true,
            text
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: "Error saving broadcast"
        });
    }
});

app.delete("/api/broadcast", async (req, res) => {
    try {
        if (!settingsCollection) {
            return res.status(503).json({
                success: false,
                error: "Database unavailable"
            });
        }

        await settingsCollection.deleteOne({
            key: "global_broadcast"
        });

        io.emit(
            "broadcast:clear"
        );

        res.json({
            success: true
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: "Error deleting broadcast"
        });
    }
});

// ===============================
// SOCKET.IO
// ===============================

io.on("connection", async (socket) => {
    console.log(
        "🔌 Player connected:",
        socket.id
    );

    try {
        if (playersCollection) {
            socket.emit(
                "leaderboard:update",
                await getAllPlayers()
            );
        }

        if (missionsCollection) {
            socket.emit(
                "missions:init",
                await missionsCollection
                    .find({})
                    .sort({
                        createdAt: -1
                    })
                    .limit(100)
                    .toArray()
            );
        }

        if (settingsCollection) {
            const broadcast =
                await settingsCollection.findOne({
                    key: "global_broadcast"
                });

            if (broadcast?.text) {
                socket.emit(
                    "broadcast:new",
                    broadcast.text
                );
            }
        }
    } catch (error) {
        console.error(
            "Socket initialization error:",
            error
        );
    }

    socket.on(
        "disconnect",
        () => {
            console.log(
                "🔌 Player disconnected:",
                socket.id
            );
        }
    );
});

// ===============================
// START
// ===============================

async function startServer() {
    await connectDB();

    server.listen(
        PORT,
        () => {
            console.log(
                `🚀 Talabat Tycoon Pro running on port ${PORT}`
            );
        }
    );
}

startServer();
