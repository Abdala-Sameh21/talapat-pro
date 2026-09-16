const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// =========================
// Environment Variables
// =========================

const MONGODB_URI = "mongodb+srv://bodacpm:112003Ab@cluster3.oqbrc.mongodb.net/?retryWrites=true&w=majority&appName=Cluster3";
// =========================
// Database
// =========================

let client;
let db;
let playersCollection;
let missionsCollection;
let settingsCollection;

// =========================
// Express
// =========================

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, ".")));

// =========================
// Helpers
// =========================

function cleanNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function cleanString(value, fallback = "") {
    if (typeof value !== "string") return fallback;
    return value.trim();
}

function normalizeUsername(value) {
    return cleanString(value).toLowerCase();
}

function cleanRiders(riders) {
    if (!Array.isArray(riders)) return [];

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
        usernameKey: normalizeUsername(name),

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

        title: cleanString(
            body.title,
            "مهمة جديدة"
        ),

        type: cleanString(
            body.type,
            "delivery"
        ),

        rewardMoney: cleanNumber(
            body.rewardMoney,
            0
        ),

        rewardXp: cleanNumber(
            body.rewardXp,
            40
        ),

        target: Math.max(
            1,
            cleanNumber(body.target, 1)
        ),

        createdAt: new Date()
    };
}

// =========================
// Admin Authentication
// =========================

function createAdminToken() {
    return crypto
        .randomBytes(32)
        .toString("hex");
}

let activeAdminTokens = new Set();

function isAdminRequest(req) {
    const token = cleanString(
        req.headers["x-admin-token"]
    );

    return Boolean(
        token &&
        activeAdminTokens.has(token)
    );
}

function requireAdmin(req, res, next) {
    if (!isAdminRequest(req)) {
        return res.status(401).json({
            success: false,
            error: "غير مصرح. يجب تسجيل دخول الأدمن."
        });
    }

    next();
}

// =========================
// Players
// =========================

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

// =========================
// MongoDB Connection
// =========================

async function connectDB() {

    if (!MONGODB_URI) {

        console.error(
            "❌ MONGODB_URI غير موجود في Environment Variables."
        );

        return;
    }

    try {

        client = new MongoClient(
            MONGODB_URI
        );

        await client.connect();

        db = client.db(
            "talabat_game"
        );

        playersCollection =
            db.collection("players");

        missionsCollection =
            db.collection("missions");

        settingsCollection =
            db.collection("settings");

        // playerId فريد
        await playersCollection.createIndex(
            {
                playerId: 1
            },
            {
                unique: true,
                sparse: true
            }
        );

        // usernameKey فريد
        try {

            await playersCollection.createIndex(
                {
                    usernameKey: 1
                },
                {
                    unique: true,
                    sparse: true,
                    name: "unique_usernameKey"
                }
            );

        } catch (indexError) {

            console.warn(
                "⚠️ تعذر إنشاء unique username index:",
                indexError.message
            );

        }

        await playersCollection.createIndex({
            name: 1
        });

        await missionsCollection.createIndex(
            {
                id: 1
            },
            {
                unique: true,
                sparse: true
            }
        );

        console.log(
            "✅ Connected to MongoDB successfully!"
        );

    } catch (error) {

        console.error(
            "❌ MongoDB connection failed:"
        );

        console.error(error);
    }
}

// =========================
// Health
// =========================

app.get(
    "/api/health",
    async (req, res) => {

        res.json({
            success: true,
            server: "Talabat Tycoon Pro",
            mongodb: Boolean(db),
            time: new Date().toISOString()
        });

    }
);

// =========================
// AUTH / LOGIN
// =========================

app.post(
    "/api/auth/login",
    async (req, res) => {

        try {

            if (!playersCollection) {

                return res.status(503).json({
                    success: false,
                    error:
                        "قاعدة البيانات غير متاحة حالياً."
                });

            }

            const name = cleanString(
                req.body.name
            );

            const password = cleanString(
                req.body.password
            );

            const requestedPlayerId =
                cleanString(
                    req.body.playerId
                );

            if (!name) {

                return res.status(400).json({
                    success: false,
                    error:
                        "اكتب اسم المستخدم أولاً."
                });

            }

            // =========================
            // ADMIN CREDENTIALS
            // =========================

            const ADMIN_USERNAME = "Boda";
            const ADMIN_PASSWORD = "2611";

            const usernameKey =
                normalizeUsername(name);

            const isAdminName =
                usernameKey ===
                normalizeUsername(
                    ADMIN_USERNAME
                );

            // =========================
            // ADMIN
            // =========================

            if (isAdminName) {

                if (
                    !password ||
                    password !== ADMIN_PASSWORD
                ) {

                    return res.status(401).json({
                        success: false,
                        error:
                            "كلمة مرور الأدمن غير صحيحة."
                    });

                }

                let adminPlayer =
                    await playersCollection.findOne({
                        usernameKey
                    });

                // دعم الحساب القديم
                if (!adminPlayer) {

                    adminPlayer =
                        await playersCollection.findOne({
                            name: ADMIN_USERNAME
                        });

                }

                const playerId =
                    adminPlayer?.playerId ||
                    requestedPlayerId ||
                    `player_${crypto.randomBytes(12).toString("hex")}`;

                const token =
                    createAdminToken();

                activeAdminTokens.add(token);

                if (
                    activeAdminTokens.size > 100
                ) {

                    const firstToken =
                        activeAdminTokens
                            .values()
                            .next()
                            .value;

                    if (firstToken) {
                        activeAdminTokens.delete(
                            firstToken
                        );
                    }

                }

                const adminData = {

                    playerId,

                    name: ADMIN_USERNAME,

                    usernameKey,

                    updatedAt: new Date()

                };

                await playersCollection.updateOne(

                    {
                        playerId
                    },

                    {
                        $set: adminData,

                        $setOnInsert: {

                            balance: 500,

                            totalRevenue: 0,

                            taxDue: 0,

                            rating: 4.8,

                            level: 1,

                            xp: 0,

                            maxXp: 100,

                            maxFleetSize: 3,

                            officeLevel: 1,

                            hasBoxUpgrade: false,

                            riders: []

                        }
                    },

                    {
                        upsert: true
                    }

                );

                const player =
                    await playersCollection.findOne({
                        playerId
                    });

                return res.json({

                    success: true,

                    isAdmin: true,

                    token,

                    playerId:
                        player.playerId,

                    name:
                        player.name,

                    player

                });

            }

            // =========================
            // باقي تسجيل دخول اللاعبين
            // =========================

            // الكود الموجود عندك بعد الجزء ده
            // يفضل كما هو بدون تغيير.

        } catch (error) {

            console.error(
                "Login error:",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    "حدث خطأ أثناء تسجيل الدخول."
            });

        }

    }
);

            // =========================
            // NORMAL USER
            // =========================

            let existingPlayer =
                await playersCollection.findOne({
                    usernameKey
                });

            // دعم الحسابات القديمة
            if (!existingPlayer) {

                existingPlayer =
                    await playersCollection.findOne({
                        name
                    });

            }

            // الاسم موجود
            if (existingPlayer) {

                // نفس الحساب
                if (
                    requestedPlayerId &&
                    existingPlayer.playerId ===
                    requestedPlayerId
                ) {

                    return res.json({

                        success: true,

                        isAdmin: false,

                        playerId:
                            existingPlayer.playerId,

                        name:
                            existingPlayer.name,

                        player:
                            existingPlayer

                    });

                }

                // شخص آخر
                return res.status(409).json({

                    success: false,

                    error:
                        "اسم المستخدم مستخدم بالفعل. اختار اسم تاني."

                });

            }

            const playerId =
                requestedPlayerId ||
                `player_${crypto.randomBytes(12).toString("hex")}`;

            const newPlayer = {

                playerId,

                name,

                usernameKey,

                balance: 500,

                totalRevenue: 0,

                taxDue: 0,

                rating: 4.8,

                level: 1,

                xp: 0,

                maxXp: 100,

                maxFleetSize: 3,

                officeLevel: 1,

                hasBoxUpgrade: false,

                riders: [],

                updatedAt: new Date()

            };

            try {

                await playersCollection.insertOne(
                    newPlayer
                );

            } catch (insertError) {

                if (
                    insertError &&
                    insertError.code === 11000
                ) {

                    return res.status(409).json({

                        success: false,

                        error:
                            "اسم المستخدم مستخدم بالفعل. اختار اسم تاني."

                    });

                }

                throw insertError;
            }

            const players =
                await getAllPlayers();

            io.emit(
                "leaderboard:update",
                players
            );

            io.emit(
                "player:update",
                newPlayer
            );

            return res.json({

                success: true,

                isAdmin: false,

                playerId,

                name,

                player:
                    newPlayer

            });

        } catch (error) {

            console.error(
                "❌ Login error:",
                error
            );

            res.status(500).json({

                success: false,

                error:
                    "حدث خطأ أثناء تسجيل الدخول."

            });

        }

    }
);

// =========================
// LOGOUT
// =========================

app.post(
    "/api/auth/logout",
    (req, res) => {

        const token =
            cleanString(
                req.headers["x-admin-token"]
            );

        if (token) {

            activeAdminTokens.delete(
                token
            );

        }

        res.json({
            success: true
        });

    }
);

// =========================
// GET ALL PLAYERS
// =========================

app.get(
    "/api/players",
    async (req, res) => {

        try {

            if (!playersCollection) {
                return res.json([]);
            }

            const players =
                await getAllPlayers();

            res.json(players);

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "Error fetching players"
            });

        }

    }
);

// =========================
// GET PLAYER BY ID
// =========================

app.get(
    "/api/players/id/:playerId",
    async (req, res) => {

        try {

            if (!playersCollection) {

                return res.status(503).json({
                    error:
                        "Database unavailable"
                });

            }

            const player =
                await playersCollection.findOne({

                    playerId:
                        req.params.playerId

                });

            if (!player) {

                return res.status(404).json({
                    error:
                        "Player not found"
                });

            }

            res.json(player);

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "Error fetching player"
            });

        }

    }
);

// =========================
// GET PLAYER BY NAME
// =========================

app.get(
    "/api/players/:name",
    async (req, res) => {

        try {

            if (!playersCollection) {

                return res.status(503).json({
                    error:
                        "Database unavailable"
                });

            }

            const name =
                decodeURIComponent(
                    req.params.name
                );

            let player =
                await playersCollection.findOne({

                    playerId: name

                });

            if (!player) {

                player =
                    await playersCollection.findOne({

                        usernameKey:
                            normalizeUsername(name)

                    });

            }

            if (!player) {

                player =
                    await playersCollection.findOne({

                        name

                    });

            }

            if (!player) {

                return res.status(404).json({
                    error:
                        "Player not found"
                });

            }

            res.json(player);

        } catch (error) {

            console.error(error);

            res.status(500).json({
                error:
                    "Error fetching player"
            });

        }

    }
);

// =========================
// SAVE PLAYER
// =========================

app.post(
    "/api/players",
    async (req, res) => {

        try {

            if (!playersCollection) {

                return res.status(503).json({

                    success: false,

                    error:
                        "Database unavailable"

                });

            }

            const player =
                cleanPlayerData(req.body);

            const existingById =
                await playersCollection.findOne({

                    playerId:
                        player.playerId

                });

            if (existingById) {

                const nameChanged =
                    normalizeUsername(
                        existingById.name
                    ) !==
                    player.usernameKey;

                if (nameChanged) {

                    const sameName =
                        await playersCollection.findOne({

                            usernameKey:
                                player.usernameKey,

                            playerId: {
                                $ne:
                                    player.playerId
                            }

                        });

                    if (sameName) {

                        return res.status(409).json({

                            success: false,

                            error:
                                "اسم المستخدم مستخدم بالفعل."

                        });

                    }

                }

            } else {

                const sameName =
                    await playersCollection.findOne({

                        usernameKey:
                            player.usernameKey

                    });

                if (
                    sameName &&
                    sameName.playerId !==
                    player.playerId
                ) {

                    return res.status(409).json({

                        success: false,

                        error:
                            "اسم المستخدم مستخدم بالفعل."

                    });

                }

            }

            await playersCollection.updateOne(

                {
                    playerId:
                        player.playerId
                },

                {
                    $set:
                        player
                },

                {
                    upsert: true
                }

            );

            const players =
                await getAllPlayers();

            io.emit(
                "leaderboard:update",
                players
            );

            io.emit(
                "player:update",
                player
            );

            res.json({

                success: true,

                player,

                players

            });

        } catch (error) {

            console.error(error);

            if (
                error &&
                error.code === 11000
            ) {

                return res.status(409).json({

                    success: false,

                    error:
                        "اسم المستخدم مستخدم بالفعل."

                });

            }

            res.status(500).json({

                success: false,

                error:
                    error.message ||
                    "Error saving player"

            });

        }

    }
);

// =========================
// ADMIN: GIVE MONEY
// =========================

app.post(
    "/api/admin/give-money",
    requireAdmin,
    async (req, res) => {

        try {

            if (!playersCollection) {

                return res.status(503).json({

                    success: false,

                    error:
                        "Database unavailable"

                });

            }

            const playerId =
                cleanString(
                    req.body.playerId
                );

            const amount =
                cleanNumber(
                    req.body.amount,
                    0
                );

            if (
                !playerId ||
                amount <= 0
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Invalid player or amount"

                });

            }

            const result =
                await playersCollection.findOneAndUpdate(

                    {
                        playerId
                    },

                    {
                        $inc: {
                            balance:
                                amount
                        },

                        $set: {
                            updatedAt:
                                new Date()
                        }
                    },

                    {
                        returnDocument:
                            "after"
                    }

                );

            const updatedPlayer =
                result &&
                result.value
                    ? result.value
                    : result;

            if (!updatedPlayer) {

                return res.status(404).json({

                    success: false,

                    error:
                        "Player not found"

                });

            }

            const players =
                await getAllPlayers();

            io.emit(
                "leaderboard:update",
                players
            );

            io.emit(
                "player:update",
                updatedPlayer
            );

            res.json({

                success: true,

                player:
                    updatedPlayer

            });

        } catch (error) {

            console.error(error);

            res.status(500).json({

                success: false,

                error:
                    "Error adding money"

            });

        }

    }
);

// =========================
// ADMIN: SET BALANCE
// =========================

app.post(
    "/api/admin/set-balance",
    requireAdmin,
    async (req, res) => {

        try {

            if (!playersCollection) {

                return res.status(503).json({

                    success: false,

                    error:
                        "Database unavailable"

                });

            }

            const playerId =
                cleanString(
                    req.body.playerId
                );

            const balance =
                Math.max(
                    0,
                    cleanNumber(
                        req.body.balance,
                        0
                    )
                );

            const result =
                await playersCollection.findOneAndUpdate(

                    {
                        playerId
                    },

                    {
                        $set: {

                            balance,

                            updatedAt:
                                new Date()

                        }
                    },

                    {
                        returnDocument:
                            "after"
                    }

                );

            const updatedPlayer =
                result &&
                result.value
                    ? result.value
                    : result;

            if (!updatedPlayer) {

                return res.status(404).json({

                    success: false,

                    error:
                        "Player not found"

                });

            }

            io.emit(
                "leaderboard:update",
                await getAllPlayers()
            );

            io.emit(
                "player:update",
                updatedPlayer
            );

            res.json({

                success: true,

                player:
                    updatedPlayer

            });

        } catch (error) {

            console.error(error);

            res.status(500).json({

                success: false,

                error:
                    "Error setting balance"

            });

        }

    }
);

// =========================
// ADMIN: SET LEVEL
// =========================

app.post(
    "/api/admin/set-level",
    requireAdmin,
    async (req, res) => {

        try {

            if (!playersCollection) {

                return res.status(503).json({

                    success: false,

                    error:
                        "Database unavailable"

                });

            }

            const playerId =
                cleanString(
                    req.body.playerId
                );

            const level =
                Math.max(
                    1,
                    cleanNumber(
                        req.body.level,
                        1
                    )
                );

            const result =
                await playersCollection.findOneAndUpdate(

                    {
                        playerId
                    },

                    {
                        $set: {

                            level,

                            updatedAt:
                                new Date()

                        }
                    },

                    {
                        returnDocument:
                            "after"
                    }

                );

            const updatedPlayer =
                result &&
                result.value
                    ? result.value
                    : result;

            if (!updatedPlayer) {

                return res.status(404).json({

                    success: false,

                    error:
                        "Player not found"

                });

            }

            io.emit(
                "player:update",
                updatedPlayer
            );

            res.json({

                success: true,

                player:
                    updatedPlayer

            });

        } catch (error) {

            console.error(error);

            res.status(500).json({

                success: false,

                error:
                    "Error setting level"

            });

        }

    }
);

// =========================
// MISSIONS
// =========================

app.get(
    "/api/missions",
    async (req, res) => {

        try {

            if (!missionsCollection) {
                return res.json([]);
            }

            const missions =
                await missionsCollection
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

                error:
                    "Error fetching missions"

            });

        }

    }
);

// =========================
// CREATE MISSION
// =========================

app.post(
    "/api/missions",
    requireAdmin,
    async (req, res) => {

        try {

            if (!missionsCollection) {

                return res.status(503).json({

                    success: false,

                    error:
                        "Database unavailable"

                });

            }

            const mission =
                cleanMission(req.body);

            await missionsCollection.insertOne(
                mission
            );

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

                error:
                    "Error creating mission"

            });

        }

    }
);

// =========================
// DELETE MISSION
// =========================

app.delete(
    "/api/missions/:missionId",
    requireAdmin,
    async (req, res) => {

        try {

            if (!missionsCollection) {

                return res.status(503).json({

                    success: false,

                    error:
                        "Database unavailable"

                });

            }

            const missionId =
                Number(
                    req.params.missionId
                );

            await missionsCollection.deleteOne({

                id:
                    missionId

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

                error:
                    "Error deleting mission"

            });

        }

    }
);

// =========================
// BROADCAST
// =========================

app.get(
    "/api/broadcast",
    async (req, res) => {

        try {

            if (!settingsCollection) {

                return res.json({
                    text: ""
                });

            }

            const setting =
                await settingsCollection.findOne({

                    key:
                        "global_broadcast"

                });

            if (!setting) {

                return res.json({
                    text: ""
                });

            }

            const expiresAt =
                setting.expiresAt ||
                null;

            if (
                expiresAt &&
                new Date(
                    expiresAt
                ).getTime() <=
                    Date.now()
            ) {

                await settingsCollection.deleteOne({

                    key:
                        "global_broadcast"

                });

                return res.json({
                    text: ""
                });

            }

            res.json({

                text:
                    setting.text ||
                    "",

                duration:
                    setting.duration ||
                    "",

                expiresAt

            });

        } catch (error) {

            console.error(error);

            res.status(500).json({

                error:
                    "Error fetching broadcast"

            });

        }

    }
);

// =========================
// BROADCAST DURATION
// =========================

function durationToMilliseconds(
    duration
) {

    switch (duration) {

        case "20s":
            return 20 * 1000;

        case "1h":
            return 60 * 60 * 1000;

        case "1d":
            return 24 * 60 * 60 * 1000;

        case "3d":
            return 3 * 24 * 60 * 60 * 1000;

        default:
            return 20 * 1000;

    }

}

// =========================
// CREATE BROADCAST
// =========================

app.post(
    "/api/broadcast",
    requireAdmin,
    async (req, res) => {

        try {

            if (!settingsCollection) {

                return res.status(503).json({

                    success: false,

                    error:
                        "Database unavailable"

                });

            }

            const text =
                cleanString(
                    req.body.text
                );

            if (!text) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Broadcast text is required"

                });

            }

            const duration =
                cleanString(
                    req.body.duration,
                    "20s"
                );

            const expiresAt =
                new Date(
                    Date.now() +
                    durationToMilliseconds(
                        duration
                    )
                );

            const data = {

                key:
                    "global_broadcast",

                text,

                duration,

                expiresAt,

                updatedAt:
                    new Date()

            };

            await settingsCollection.updateOne(

                {
                    key:
                        "global_broadcast"
                },

                {
                    $set:
                        data
                },

                {
                    upsert:
                        true
                }

            );

            io.emit(
                "broadcast:new",
                text,
                {
                    duration,
                    expiresAt
                }
            );

            res.json({

                success: true,

                text,

                duration,

                expiresAt

            });

        } catch (error) {

            console.error(error);

            res.status(500).json({

                success: false,

                error:
                    "Error saving broadcast"

            });

        }

    }
);

// =========================
// DELETE BROADCAST
// =========================

app.delete(
    "/api/broadcast",
    requireAdmin,
    async (req, res) => {

        try {

            if (!settingsCollection) {

                return res.status(503).json({

                    success: false,

                    error:
                        "Database unavailable"

                });

            }

            await settingsCollection.deleteOne({

                key:
                    "global_broadcast"

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

                error:
                    "Error deleting broadcast"

            });

        }

    }
);

// =========================
// SOCKET.IO
// =========================

io.on(
    "connection",
    async (socket) => {

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

                        key:
                            "global_broadcast"

                    });

                if (
                    broadcast?.text &&
                    (
                        !broadcast.expiresAt ||
                        new Date(
                            broadcast.expiresAt
                        ).getTime() >
                            Date.now()
                    )
                ) {

                    socket.emit(

                        "broadcast:new",

                        broadcast.text,

                        {

                            duration:
                                broadcast.duration ||
                                "",

                            expiresAt:
                                broadcast.expiresAt ||
                                null

                        }

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

    }
);

// =========================
// START SERVER
// =========================

async function startServer() {

    await connectDB();

    server.listen(
        PORT,
        () => {

            console.log(
                `🚀 Talabat Tycoon Pro running on port ${PORT}`
            );

            if (!MONGODB_URI) {

                console.log(
                    "⚠️ أضف MONGODB_URI إلى Railway Variables."
                );

            }

            console.log(
                `👑 Admin username: ${ADMIN_USERNAME}`
            );

        }
    );

}

startServer().catch(
    (error) => {

        console.error(
            "❌ Server startup failed:",
            error
        );

        process.exit(1);

    }
);
