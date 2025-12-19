import 'dotenv/config';
import { setupBot } from './bot/bot';
import http from 'http';

// Tiny Health Check Server for Render Free Tier
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive\n');
}).listen(PORT, () => {
    console.log(`📡 Health check server listening on port ${PORT}`);
});

const MAX_RETRIES = 10;
const INITIAL_DELAY = 5000; // 5 seconds

// Global Error Handlers to prevent crash
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

async function launchWithRetry(bot: any, attempt: number = 1): Promise<void> {
    try {
        console.log(`[Attempt ${attempt}/${MAX_RETRIES}] Connecting to Telegram...`);
        await bot.launch();
        console.log('✅ Bot is running!');
    } catch (error: any) {
        const isNetworkError = error.code === 'ETIMEDOUT' ||
            error.code === 'ECONNRESET' ||
            error.code === 'ENOTFOUND' ||
            error.message?.includes('timeout');

        if (isNetworkError && attempt < MAX_RETRIES) {
            const delay = INITIAL_DELAY * Math.pow(1.5, attempt - 1); // Exponential backoff
            console.log(`⚠️ Network error: ${error.code || error.message}`);
            console.log(`⏳ Retrying in ${Math.round(delay / 1000)} seconds...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return launchWithRetry(bot, attempt + 1);
        } else {
            throw error;
        }
    }
}

async function main() {
    const token = process.env.TELEGRAM_TOKEN;
    if (!token || token === '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11') {
        console.error('ERROR: Please set a valid TELEGRAM_TOKEN in .env file.');
        process.exit(1);
    }

    console.log('--- System Check ---');
    console.log('Node Version:', process.version);
    console.log('Environment:', process.env.NODE_ENV || 'development');
    console.log('Token Length:', token.length);
    console.log('--------------------');

    console.log('[1/3] Initializing Bot & Database...');
    const bot = setupBot(token);
    console.log('[2/3] Bot setup complete.');

    console.log('[3/3] Verifying Telegram connection...');
    try {
        const me = await bot.telegram.getMe();
        console.log(`✅ Connected as @${me.username} (${me.id})`);
    } catch (err: any) {
        console.error('❌ Telegram connection failed:', err.message);
        process.exit(1);
    }

    console.log('CaseView Bot is launching...');

    // Enable graceful stop
    process.once('SIGINT', () => {
        console.log('SIGINT received, stopping bot...');
        bot.stop('SIGINT');
    });
    process.once('SIGTERM', () => {
        console.log('SIGTERM received, stopping bot...');
        bot.stop('SIGTERM');
    });

    await launchWithRetry(bot);
}

main().catch((err) => {
    console.error('❌ Bot failed to start after all retries:', err.message || err);
    process.exit(1);
});
