import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { PrismaClient } from '@prisma/client';
import { setupBot } from './bot/bot';
import path from 'path';

// Initialize App and DB
const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 10000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme_to_something_secure'; // Simple auth token

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public'))); // Serve admin.html

// 🛠️ DATABASE_URL FIX (Same as before)
if (process.env.DATABASE_URL) {
    process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/['"]/g, '').trim();
    if (!process.env.DATABASE_URL.startsWith('postgresql://') && !process.env.DATABASE_URL.startsWith('postgres://')) {
        process.env.DATABASE_URL = `postgresql://${process.env.DATABASE_URL}`;
    }
}

// ================= API ROUTES (Protected) =================

// Middleware to check token
const checkAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = req.query.token as string || req.headers['x-admin-token'] as string;
    if (token === ADMIN_SECRET) {
        next();
    } else {
        res.status(403).json({ error: 'Unauthorized' });
    }
};

// GET ALL USERS
app.get('/api/admin/users', checkAuth, async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            orderBy: { createdAt: 'desc' }
        });
        // Convert BigInt to String for JSON serialization
        const safeUsers = JSON.parse(JSON.stringify(users, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
        ));
        res.json(safeUsers);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// GET SINGLE USER
app.get('/api/admin/users/:id', checkAuth, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { telegramId: BigInt(req.params.id) }
        });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const safeUser = JSON.parse(JSON.stringify(user, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
        ));
        res.json(safeUser);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// UPDATE USER (User Edit Modal)
app.put('/api/admin/users/:id', checkAuth, async (req, res) => {
    try {
        const { subscription, subscriptionExp, isVerified, isBanned } = req.body;

        await prisma.user.update({
            where: { telegramId: BigInt(req.params.id) },
            data: {
                subscription,
                subscriptionExp: subscriptionExp ? new Date(subscriptionExp) : null,
                isVerified,
                isBanned
            }
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to update user' });
    }
});

// DELETE USER
app.delete('/api/admin/users/:id', checkAuth, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { telegramId: BigInt(req.params.id) } });
        if (user) {
            // Delete related data first
            await prisma.caseMatter.deleteMany({ where: { userId: user.id } });
            await prisma.user.delete({ where: { id: user.id } });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// Health Check
app.get('/health', (req, res) => res.send('Bot & Dashboard Alive'));

// ================= BOT LAUNCHER =================

let token = process.env.TELEGRAM_TOKEN;
if (token) token = token.replace(/['"]/g, '').trim();

if (!token || token.includes('ABC-DEF')) {
    console.error('ERROR: Please set a valid TELEGRAM_TOKEN in .env file.');
    process.exit(1);
}

const bot = setupBot(token);

// Graceful Stop
const stop = (signal: string) => {
    console.log(`${signal} received. Stopping...`);
    bot.stop(signal);
    process.exit(0);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

// Start Server and Bot
app.listen(PORT, () => {
    console.log(`🚀 Server & Dashboard running on port ${PORT}`);
    console.log(`🤖 Bot starting...`);

    // Launch Bot with Retry Logic (Inline)
    const launch = async (attempt = 1) => {
        try {
            await bot.launch();
            console.log('✅ Bot is polling!');
        } catch (err: any) {
            if (attempt < 10) {
                console.log(`⚠️ Bot launch retry ${attempt}... (${err.message})`);
                setTimeout(() => launch(attempt + 1), 5000);
            } else {
                console.error('❌ Bot failed to launch');
            }
        }
    };
    launch();
});

