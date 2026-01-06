import { Telegraf, Context } from 'telegraf';
import { PrismaClient } from '@prisma/client';
import { analyzeCaseViability } from '../core/viability';
import { searchAllDatabases, searchPrecedents, getExtendedResearchLinks } from '../services/legalResearch';
import { aiService } from '../services/ai';
import { extractTextFromDocument, transcribeAudio } from '../services/extraction';
import { generatePDF, generateWord } from '../services/exportService';
import { COUNTRIES, getPlanPrices, getCountryByCode } from '../services/currencyService';
import { initializePayment, getPlanAmount } from '../services/paymentService';


// 🛠️ DATABASE_URL AUTO-FIX (Must be before Prisma Client creation)
if (process.env.DATABASE_URL) {
    let dbUrl = process.env.DATABASE_URL.replace(/['"]/g, '').trim();
    if (!dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://')) {
        console.warn('⚠️ DATABASE_URL missing protocol in bot.ts. Fixing...');
        dbUrl = `postgresql://${dbUrl}`;
    }
    process.env.DATABASE_URL = dbUrl;
}

// 🛠️ TOKEN AUTO-FIX
if (process.env.TELEGRAM_TOKEN) {
    process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN.replace(/['"]/g, '').trim();
}

console.log('[DB] Initializing Prisma Client...');
const prisma = new PrismaClient();
console.log('[DB] Prisma Client created.');

// Simple in-memory session (use Redis/Database in production)
const sessions: Record<number, {
    step: 'IDLE' | 'WAITING_FIRM_CODE' | 'WAITING_JURISDICTION' | 'WAITING_COURT' | 'WAITING_PARTIES' | 'WAITING_FACTS' | 'WAITING_QUESTION' | 'WAITING_SHARE_USER' | 'SIGNUP_ACCOUNT_TYPE' | 'SIGNUP_FIRM_NAME' | 'SIGNUP_FIRM_STATE' | 'SIGNUP_BRANCH_NAME' | 'SIGNUP_NAME' | 'SIGNUP_EMAIL' | 'SIGNUP_PHONE' | 'SIGNUP_COUNTRY' | 'SIGNUP_TELEGRAM_ID' | 'SIGNUP_ADDRESS' | 'SIGNUP_JOB' | 'SIGNUP_REG_NUMBER' | 'WAITING_VERIFY' | 'EDIT_FULLNAME' | 'EDIT_EMAIL' | 'EDIT_PHONE' | 'EDIT_ADDRESS' | 'EDIT_JOBPOSITION' | 'EDIT_FIRMCODE' | 'WAITING_ADDSTAFF' | 'SCENARIO_Q1' | 'SCENARIO_Q2' | 'SCENARIO_Q3' | 'SCENARIO_Q4' | 'SCENARIO_Q5' | 'WAITING_LINK' | 'EXPORT_FORMAT' | 'EXPORT_WORDS' | 'OCR_PREVIEW' | 'OCR_EDIT';
    data: {
        jurisdiction?: string;
        court?: string;
        parties?: string;
        facts?: string;
        currentCaseId?: number;
        currentRefCode?: string;
        verificationCode?: string;
        // User Profile Data
        fullName?: string;
        phone?: string;
        email?: string; // Added for completeness
        // For export - store full conversation
        analysis?: string;
        conversationHistory?: Array<{ role: 'user' | 'bot', content: string, timestamp: Date }>;
        scenarioInputs?: {
            outcome?: string;
            evidence?: string;
            opposing?: string;
            jurisdiction?: string;
            caveats?: string;
        };
        exportSettings?: {
            format?: 'PDF' | 'Word';
            wordCount?: string;
        };
        precedents?: any[];
        ocrText?: string; // For OCR preview/edit workflow
    },
    staging?: {
        type: 'text' | 'file';
        content: string;
        mime: string;
    }
}> = {};

// Admin helper function
async function isAdmin(telegramId: number): Promise<{ isAdmin: boolean; role: string | null }> {
    const admin = await prisma.admin.findUnique({ where: { telegramId: BigInt(telegramId) } });
    return { isAdmin: !!admin, role: admin?.role || null };
}

// Plan limits
const PLAN_LIMITS: Record<string, number> = { FREE: 2, PRO: 10, FIRM: 20, BAR: 999999 };

export function setupBot(token: string) {
    const bot = new Telegraf(token, {
        handlerTimeout: 300000 // 5 minutes for large file processing
    });

    // Debug Middleware
    bot.use(async (ctx, next) => {
        console.log(`[Update] Type: ${ctx.updateType}`, ctx.update);
        await next();
    });

    // Ban check middleware
    // Ban check middleware

    // Error Handler
    bot.catch((err: any, ctx) => {
        console.error(`❌ Bot Error for update ${ctx.updateType}:`, err);
    });

    // Ban & Approval check middleware
    bot.use(async (ctx, next) => {
        try {
            if (ctx.from) {
                const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from.id) } });
                if (user?.isBanned) {
                    return ctx.reply('⛔ Your account has been suspended. Contact support.');
                }
                // Check Approval Status
                if (user && user.approvalStatus === 'PENDING') {
                    const isStart = ctx.message && 'text' in ctx.message && ctx.message.text === '/start';
                    if (!isStart) {
                        return ctx.reply('⏳ **Account Pending Approval**\n\nYour Firm/Bar registration is under review by an Administrator. You will be notified when approved.');
                    }
                }
            }
            await next();
        } catch (err: any) {
            console.error('❌ Middleware Error:', err.message || err);
            // Optionally reply to user so they aren't left hanging
            try { await ctx.reply(`⚠️ Internal Error: ${err.message || err}`); } catch { }
        }
    });

    // ... (start and history commands remain)

    // SIGNUP COMMAND - Full user registration
    bot.command('signup', async (ctx) => {
        const userId = ctx.from.id;
        sessions[userId] = { step: 'SIGNUP_ACCOUNT_TYPE', data: {} };
        await ctx.reply('📝 **Complete Your Profile**\n\nFirst, select your **Account Type**:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '👤 Individual', callback_data: 'acct_INDIVIDUAL' }],
                    [{ text: '🏢 Law Firm', callback_data: 'acct_FIRM' }],
                    [{ text: '⚖️ Bar Association', callback_data: 'acct_BAR' }],
                    [{ text: '🤝 Join a Team', callback_data: 'acct_JOIN' }]
                ]
            }
        });
    });

    bot.action('acct_JOIN', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply('🤝 **Join a Team**\n\nTo join a Law Firm or Bar Association team, you need an **Invite Link** from the organization owner.\n\nAsk your administrator to go to their **Manage Team** section and share the link with you.');
    });

    // Account type selection handlers
    bot.action(/^acct_(INDIVIDUAL|FIRM|BAR)$/, async (ctx) => {
        const accountType = ctx.match[1];
        const userId = ctx.from.id;

        await ctx.answerCbQuery();
        await prisma.user.update({
            where: { telegramId: BigInt(userId) },
            data: { accountType }
        });

        if (accountType === 'INDIVIDUAL') {
            sessions[userId] = { step: 'SIGNUP_NAME', data: {} };
            await ctx.reply('👤 **Individual Account**\n\nStep 1/5: What is your **Full Name**?');
        } else if (accountType === 'FIRM') {
            sessions[userId] = { step: 'SIGNUP_FIRM_NAME', data: {} };
            await ctx.reply('🏢 **Law Firm Account**\n\nStep 1/6: What is your **Firm Name**?');
        } else if (accountType === 'BAR') {
            sessions[userId] = { step: 'SIGNUP_BRANCH_NAME', data: {} };
            await ctx.reply('⚖️ **Bar Association Account**\n\nStep 1/6: What is the **Branch/Chapter Name**?');
        }
    });

    // HELP COMMAND - User Guide Summary
    bot.command('help', async (ctx) => {
        const helpText = `📖 **CaseView Bot - Quick Guide**

**🚀 Getting Started**
/start - Welcome menu
/signup - Create your profile
/profile - View your info

**📁 Case Management**
/newbrief - Start a new legal case
/history - View your saved cases
/capture - Quick photo/audio upload
• Send any image → automatic text extraction (OCR)

**🔍 Research & Analysis**
• Upload documents to get AI analysis
• Use "Ask Question" to query case facts
• Use "Run Scenario" to simulate outcomes
• Use "Find Precedents" for legal research

**💎 Subscription**
/subscribe - View plans & upgrade
/myplan - Check your usage limits

**👥 Team (Firms/Bars)**
/team - Manage your team
/addstaff - Invite staff members

**📤 Export**
• Select "Export" on any case
• Choose PDF or Word format

**💡 Tips**
• Type "Skip" during signup to skip optional fields
• Open cases from /history to ask questions
• Use /search [keywords] for custom research

_Need more help? Contact support._`;

        await ctx.reply(helpText, { parse_mode: 'Markdown' });
    });

    // SUBSCRIBE COMMAND - Subscription management with detailed plans
    bot.command('subscribe', async (ctx) => {
        const userId = ctx.from.id;

        // Get user's country and currency
        const user = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) } });
        const userCurrency = user?.preferredCurrency || 'USD';
        const userCountry = user?.country || 'United States';

        // Get localized prices
        const pricesArray = await getPlanPrices(userCurrency);
        const proPriceLocal = pricesArray.find(p => p.name === 'PRO')?.localFormatted || '';
        const firmPriceLocal = pricesArray.find(p => p.name === 'FIRM')?.localFormatted || '';
        const barPriceLocal = pricesArray.find(p => p.name === 'BAR')?.localFormatted || '';

        const planDetails = `💎 **Subscription Plans**
📍 Prices for: ${userCountry}

**🆓 FREE - $0/mo**
• 2 cases per month
• Basic AI analysis
• PDF export only

**⭐ PRO - $8/mo** ${proPriceLocal ? `(${proPriceLocal})` : ''}
• 10 cases per month
• AI scenario simulation
• PDF & Word export
• Priority processing

**🏢 FIRM - $49/mo** ${firmPriceLocal ? `(${firmPriceLocal})` : ''}
• 20 cases per month
• All PRO features
• Add up to 15 staff members
• Shared team dashboard
• Priority support

**⚖️ BAR ASSOCIATION - $199/mo** ${barPriceLocal ? `(${barPriceLocal})` : ''}
• Unlimited cases
• All FIRM features
• Add up to 100 members
• White-label branding
• API access
• Analytics dashboard

Select a plan:`;

        await ctx.reply(planDetails, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🆓 FREE ($0)', callback_data: 'plan_FREE' }],
                    [{ text: `⭐ PRO ($8${proPriceLocal ? ' / ' + proPriceLocal : ''})`, callback_data: 'plan_PRO' }],
                    [{ text: `🏢 FIRM ($49${firmPriceLocal ? ' / ' + firmPriceLocal : ''})`, callback_data: 'plan_FIRM' }],
                    [{ text: `⚖️ BAR ($199${barPriceLocal ? ' / ' + barPriceLocal : ''})`, callback_data: 'plan_BAR' }],
                    [{ text: '🌍 Change Country', callback_data: 'change_country' }]
                ]
            }
        });
    });

    // CHANGE COUNTRY HANDLER
    bot.action('change_country', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply('🌍 **Select Your Country/Region**\n\nThis sets your preferred currency for pricing:', {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🇳🇬 Nigeria', callback_data: 'set_country_NG' },
                        { text: '🇺🇸 USA', callback_data: 'set_country_US' }
                    ],
                    [
                        { text: '🇬🇧 UK', callback_data: 'set_country_GB' },
                        { text: '🇪🇺 Europe', callback_data: 'set_country_EU' }
                    ],
                    [
                        { text: '🇬🇭 Ghana', callback_data: 'set_country_GH' },
                        { text: '🇰🇪 Kenya', callback_data: 'set_country_KE' }
                    ],
                    [
                        { text: '🇿🇦 South Africa', callback_data: 'set_country_ZA' },
                        { text: '🇮🇳 India', callback_data: 'set_country_IN' }
                    ]
                ]
            }
        });
    });

    // SET COUNTRY HANDLER
    bot.action(/^set_country_(\w+)/, async (ctx) => {
        const countryCode = ctx.match[1];
        const userId = ctx.from.id;

        const countryMap: Record<string, { name: string; currency: string }> = {
            NG: { name: 'Nigeria', currency: 'NGN' },
            US: { name: 'United States', currency: 'USD' },
            GB: { name: 'United Kingdom', currency: 'GBP' },
            EU: { name: 'Europe', currency: 'EUR' },
            GH: { name: 'Ghana', currency: 'GHS' },
            KE: { name: 'Kenya', currency: 'KES' },
            ZA: { name: 'South Africa', currency: 'ZAR' },
            IN: { name: 'India', currency: 'INR' }
        };

        const country = countryMap[countryCode] || { name: 'United States', currency: 'USD' };

        await prisma.user.update({
            where: { telegramId: BigInt(userId) },
            data: { country: country.name, preferredCurrency: country.currency }
        });

        await ctx.answerCbQuery(`Country set to ${country.name}`);
        await ctx.reply(`✅ **Country Updated**\n\n📍 ${country.name}\n💱 Currency: ${country.currency}\n\nUse /subscribe to see prices in your currency.`);
    });

    // MY PLAN COMMAND - View current subscription
    bot.command('myplan', async (ctx) => {
        const user = await prisma.user.findUnique({
            where: { telegramId: BigInt(ctx.from.id) },
            include: { teamMembers: true }
        });
        if (!user) return ctx.reply('Please /signup first.');

        const limits: Record<string, number> = { FREE: 2, PRO: 10, FIRM: 20, BAR: 999999 };
        const staffLimits: Record<string, number> = { FREE: 0, PRO: 0, FIRM: 15, BAR: 100 };
        const prices: Record<string, string> = { FREE: '$0', PRO: '$8', FIRM: '$49', BAR: '$199' };

        const plan = user.subscription;
        const limit = limits[plan] || 2;
        const staffLimit = staffLimits[plan] || 0;

        let msg = `💎 **Your Plan: ${plan}** (${prices[plan]}/mo)\n\n`;
        msg += `📊 **Usage This Month**\n`;
        msg += `Cases: ${user.monthlyUsage}/${limit === 999999 ? '∞' : limit}\n\n`;
        msg += `👥 **Team**\n`;
        msg += `Staff members: ${user.teamMembers?.length || 0}/${staffLimit === 0 ? 'N/A' : staffLimit}\n\n`;

        if (plan === 'FREE') {
            msg += `⬆️ Upgrade to PRO for more cases!\nUse /subscribe`;
        } else if (plan === 'PRO') {
            msg += `⬆️ Upgrade to FIRM to add team members!\nUse /subscribe`;
        }

        await ctx.reply(msg);
    });

    // EDIT PROFILE COMMAND
    bot.command('editprofile', async (ctx) => {
        await ctx.reply('✏️ **Edit Profile**\n\nWhat would you like to edit?', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📛 Full Name', callback_data: 'edit_fullName' }],
                    [{ text: '📧 Email', callback_data: 'edit_email' }],
                    [{ text: '📱 Phone', callback_data: 'edit_phone' }],
                    [{ text: '📍 Address', callback_data: 'edit_address' }],
                    [{ text: '💼 Job Position', callback_data: 'edit_jobPosition' }],
                    [{ text: '🆔 Firm Code', callback_data: 'edit_firmCode' }],
                    [{ text: '❌ Cancel', callback_data: 'qa_done' }]
                ]
            }
        });
    });

    // DELETE ACCOUNT COMMAND
    bot.command('deleteaccount', async (ctx) => {
        await ctx.reply('⚠️ **Delete Account**\n\nThis will permanently delete:\n• Your profile\n• All your cases\n• All your data\n\nThis action CANNOT be undone!', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🗑 Yes, Delete My Account', callback_data: 'confirm_delete_account' }],
                    [{ text: '❌ Cancel', callback_data: 'qa_done' }]
                ]
            }
        });
    });

    // TEAM COMMAND - Manage team (FIRM/BAR only)
    bot.command('team', async (ctx) => {
        const user = await prisma.user.findUnique({
            where: { telegramId: BigInt(ctx.from.id) },
            include: { teamMembers: true }
        });

        if (!user) return ctx.reply('Please /signup first.');

        if (user.subscription !== 'FIRM' && user.subscription !== 'BAR') {
            return ctx.reply('👥 **Team Management**\n\nTeam features are only available on FIRM ($49/mo) and BAR ASSOCIATION ($199/mo) plans.\n\nUse /subscribe to upgrade.');
        }

        const staffLimit = user.subscription === 'BAR' ? 100 : 15;
        const members = user.teamMembers || [];

        let msg = `👥 **Your Team** (${members.length}/${staffLimit})\n\n`;

        if (members.length === 0) {
            msg += `No team members yet.\n\n`;
        } else {
            members.forEach((m, i) => {
                msg += `${i + 1}. ${m.fullName || m.username || `User ${m.id}`}\n`;
            });
            msg += '\n';
        }

        msg += `To add a staff member, share this invite link:\nhttps://t.me/${ctx.botInfo.username}?start=invite_${user.firmCode}\n\nOr use:\n/addstaff @username`;

        await ctx.reply(msg);
    });

    // ADD STAFF COMMAND - Add team member (FIRM/BAR only)
    bot.command('addstaff', async (ctx) => {
        const userId = ctx.from.id;
        const user = await prisma.user.findUnique({
            where: { telegramId: BigInt(userId) },
            include: { teamMembers: true }
        });

        if (!user) return ctx.reply('Please /signup first.');

        if (user.subscription !== 'FIRM' && user.subscription !== 'BAR') {
            return ctx.reply('Team features require FIRM or BAR ASSOCIATION plan.\n\nUse /subscribe to upgrade.');
        }

        const staffLimit = user.subscription === 'BAR' ? 100 : 15;
        if ((user.teamMembers?.length || 0) >= staffLimit) {
            return ctx.reply(`You've reached your staff limit (${staffLimit}).\n\n${user.subscription === 'FIRM' ? 'Upgrade to BAR ASSOCIATION for up to 100 members.' : 'Contact support for custom plans.'}`);
        }

        // Set session to wait for username
        sessions[userId] = sessions[userId] || { step: 'IDLE', data: {} };
        sessions[userId].step = 'WAITING_ADDSTAFF';

        await ctx.reply('👤 **Add Staff Member**\n\nEnter the @username of the staff member to add:\n\n_They must have already started the bot._');
    });

    // PROFILE COMMAND - View user profile
    bot.command('profile', async (ctx) => {
        const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from.id) } });
        if (!user) return ctx.reply('Profile not found. Use /signup to register.');

        await ctx.reply(`👤 **Your Profile**\n\n📛 Name: ${user.fullName || 'Not set'}\n📧 Email: ${user.email || 'Not set'}\n📱 Phone: ${user.phone || 'Not set'}\n📍 Address: ${user.address || 'Not set'}\n💼 Position: ${user.jobPosition || 'Not set'}\n🆔 Firm Code: ${user.firmCode || 'Not set'}\n💎 Plan: ${user.subscription}\n✅ Verified: ${user.isVerified ? 'Yes' : 'No'}\n\nUse /signup to update your profile.`);
    });

    // VERIFY COMMAND - Send verification code
    bot.command('verify', async (ctx) => {
        const userId = ctx.from.id;
        const user = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) } });

        if (!user) {
            return ctx.reply('Please complete /signup first before verifying.');
        }

        if (user.isVerified) {
            return ctx.reply('✅ Your account is already verified!');
        }

        // Generate 8-digit verification code
        const code = Math.floor(10000000 + Math.random() * 90000000).toString();

        // Store code in session
        if (!sessions[userId]) sessions[userId] = { step: 'IDLE', data: {} };
        sessions[userId].data.verificationCode = code;
        sessions[userId].step = 'WAITING_VERIFY';

        // Send code via Telegram
        await ctx.reply(`🔐 **Verification Code**\n\nYour unique 8-digit code is:\n\n**${code}**\n\n⚠️ Do NOT share this code with anyone!`);

        // Note: Actual verification happens in the Wizard 'text' handler (WAITING_VERIFY)
        return;
    });

    // ============= ADMIN COMMANDS =============

    // ADMIN DASHBOARD
    // ADMIN: Approve User
    bot.command('approve', async (ctx) => {
        const adminWait = await isAdmin(ctx.from.id);
        if (!adminWait.isAdmin) return;

        const args = ctx.message.text.split(' ');
        const targetId = args[1];

        if (!targetId) return ctx.reply('Usage: /approve <telegram_id>');

        try {
            await prisma.user.update({
                where: { telegramId: BigInt(targetId) },
                data: { approvalStatus: 'APPROVED' } as any
            });
            await ctx.reply(`✅ User ${targetId} APPROVED.`);
            try {
                await ctx.telegram.sendMessage(targetId, '✅ **Account Approved!**\n\nYour registration has been verified. You can now use the bot.');
            } catch (e) { ctx.reply('Could not notify user (blocked bot?)'); }
        } catch (e) {
            ctx.reply('❌ Error approving user. Check ID.');
        }
    });

    // ADMIN: Pending List
    bot.command('pending', async (ctx) => {
        const adminWait = await isAdmin(ctx.from.id);
        if (!adminWait.isAdmin) return;

        const pending = await prisma.user.findMany({
            where: {
                approvalStatus: 'PENDING'
            }
        });

        if (pending.length === 0) return ctx.reply('No pending approvals.');

        const list = pending.map(u => `• ${u.firstName || u.username} (ID: ${u.telegramId}) - ${u.accountType} - Reg: ${u.registrationNumber}`).join('\n');
        await ctx.reply(`⏳ **Pending Approvals**\n\n${list}`);
    });

    bot.command('admin', async (ctx) => {
        const adminCheck = await isAdmin(ctx.from.id);
        if (!adminCheck.isAdmin) return ctx.reply('⛔ Access denied.');

        const appUrl = process.env.WEBAPP_URL || 'https://caseview-bot.onrender.com'; // Defaulting to generic, user should update
        const token = process.env.ADMIN_SECRET || 'changeme_to_something_secure';
        const dashboardUrl = `${appUrl}/admin.html?token=${token}`;

        await ctx.reply(`🔐 **Admin Dashboard**\n\nRole: ${adminCheck.role}\n\nCommands:\n/users - List all users\n/stats - Bot statistics\n/ban @username - Ban/unban user\n/setplan @username PLAN - Set user plan\n/broadcast MESSAGE - Send to all users`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🛠 Open Dashboard', web_app: { url: dashboardUrl } }],
                    [{ text: '📊 Stats', callback_data: 'admin_stats' }, { text: '👥 Users', callback_data: 'admin_users' }],
                    [{ text: '📢 Broadcast', callback_data: 'admin_broadcast' }]
                ]
            }
        });
    });

    // USERS LIST
    bot.command('users', async (ctx) => {
        const adminCheck = await isAdmin(ctx.from.id);
        if (!adminCheck.isAdmin) return ctx.reply('⛔ Access denied.');

        const users = await prisma.user.findMany({ take: 20, orderBy: { createdAt: 'desc' } });
        const totalUsers = await prisma.user.count();

        let msg = `👥 **Users** (${totalUsers} total)\n\n`;
        users.forEach((u, i) => {
            msg += `${i + 1}. ${u.fullName || u.username} (ID: ${u.telegramId})\n   Plan: ${u.subscription} | Verified: ${u.isVerified ? '✅' : '❌'}\n`;
        });
        msg += '\nusage: /userinfo <id> to see full details\nusage: /ban @username to ban/unban';

        await ctx.reply(msg);
    });

    // ADMIN: Full User Info
    bot.command('userinfo', async (ctx) => {
        const adminCheck = await isAdmin(ctx.from.id);
        if (!adminCheck.isAdmin) return ctx.reply('⛔ Access denied.');

        const args = ctx.message.text.split(' ');
        if (args.length < 2) return ctx.reply('Usage: /userinfo <telegram_id_or_username>');

        const target = args[1];
        let user;

        // Try finding by ID first, then username
        if (/^\d+$/.test(target)) {
            user = await prisma.user.findUnique({ where: { telegramId: BigInt(target) } });
        } else {
            const username = target.replace('@', '');
            user = await prisma.user.findFirst({ where: { username } });
        }

        if (!user) return ctx.reply('❌ User not found.');

        const info = `👤 **FULL USER PROFILE**
-------------------------
**ID:** \`${user.telegramId}\`
**Username:** @${user.username || 'N/A'}
**Full Name:** ${user.fullName || 'N/A'}
**Account Type:** ${user.accountType}
**Plan:** ${user.subscription} (Exp: ${user.subscriptionExp ? user.subscriptionExp.toLocaleDateString() : 'N/A'})

**CONTACT:**
📧 Email: ${user.email || 'N/A'}
📱 Phone: ${user.phone || 'N/A'}
📍 Address: ${user.address || 'N/A'}

**PROFESSIONAL:**
💼 Job: ${user.jobPosition || 'N/A'}
📝 Reg Number: ${user.registrationNumber || 'N/A'}
🏢 Firm Name: ${user.firmName || 'N/A'} (${user.firmState || 'N/A'})
⚖️ Branch: ${user.branchName || 'N/A'}
🆔 Firm Code: ${user.firmCode || 'N/A'}

**STATUS:**
✅ Verified: ${user.isVerified ? 'YES' : 'NO'}
⛔ Banned: ${user.isBanned ? 'YES' : 'NO'}
⏳ Approval: ${user.approvalStatus}
Team Owner ID: ${user.teamOwnerId || 'None'}
Created: ${user.createdAt.toLocaleDateString()}
-------------------------`;

        await ctx.reply(info, { parse_mode: 'Markdown' });
    });


    // STATS
    bot.command('stats', async (ctx) => {
        const adminCheck = await isAdmin(ctx.from.id);
        if (!adminCheck.isAdmin) return ctx.reply('⛔ Access denied.');

        const totalUsers = await prisma.user.count();
        const totalCases = await prisma.caseMatter.count();
        const freeUsers = await prisma.user.count({ where: { subscription: 'FREE' } });
        const proUsers = await prisma.user.count({ where: { subscription: 'PRO' } });
        const firmUsers = await prisma.user.count({ where: { subscription: 'FIRM' } });
        const barUsers = await prisma.user.count({ where: { subscription: 'BAR' } });
        const verifiedUsers = await prisma.user.count({ where: { isVerified: true } });

        await ctx.reply(`📊 **Bot Statistics**\n\n👥 Total Users: ${totalUsers}\n✅ Verified: ${verifiedUsers}\n📁 Total Cases: ${totalCases}\n\n**Subscriptions:**\n🆓 FREE: ${freeUsers}\n⭐ PRO: ${proUsers}\n🏢 FIRM: ${firmUsers}\n⚖️ BAR: ${barUsers}`);
    });

    // BAN/UNBAN USER
    bot.command('ban', async (ctx) => {
        const adminCheck = await isAdmin(ctx.from.id);
        if (!adminCheck.isAdmin) return ctx.reply('⛔ Access denied.');

        const args = ctx.message.text.split(' ');
        if (args.length < 2) return ctx.reply('Usage: /ban @username');

        const username = args[1].replace('@', '');
        const user = await prisma.user.findFirst({ where: { username } });

        if (!user) return ctx.reply(`User @${username} not found.`);

        const newBanStatus = !user.isBanned;
        await prisma.user.update({ where: { id: user.id }, data: { isBanned: newBanStatus } });

        await ctx.reply(`${newBanStatus ? '⛔ Banned' : '✅ Unbanned'}: @${username}`);
    });

    // SET PLAN
    bot.command('setplan', async (ctx) => {
        const adminCheck = await isAdmin(ctx.from.id);
        if (!adminCheck.isAdmin) return ctx.reply('⛔ Access denied.');

        const args = ctx.message.text.split(' ');
        if (args.length < 3) return ctx.reply('Usage: /setplan @username PLAN\nPlans: FREE, PRO, FIRM, BAR');

        const username = args[1].replace('@', '');
        const plan = args[2].toUpperCase();

        if (!['FREE', 'PRO', 'FIRM', 'BAR'].includes(plan)) {
            return ctx.reply('Invalid plan. Use: FREE, PRO, FIRM, or BAR');
        }

        const user = await prisma.user.findFirst({ where: { username } });
        if (!user) return ctx.reply(`User @${username} not found.`);

        await prisma.user.update({
            where: { id: user.id },
            data: {
                subscription: plan,
                subscriptionExp: plan !== 'FREE' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null
            }
        });

        await ctx.reply(`✅ @${username} is now on ${plan} plan.`);
    });

    // EXTEND PLAN (Add days)
    bot.command('extend', async (ctx) => {
        const adminCheck = await isAdmin(ctx.from.id);
        if (!adminCheck.isAdmin) return ctx.reply('⛔ Access denied.');

        const args = ctx.message.text.split(' ');
        if (args.length < 3) return ctx.reply('Usage: /extend @username DAYS\nExample: /extend @chidi 10');

        const username = args[1].replace('@', '');
        const days = parseInt(args[2]);

        if (isNaN(days) || days < 1) return ctx.reply('Please provide a valid number of days.');

        const user = await prisma.user.findFirst({ where: { username } });
        if (!user) return ctx.reply(`User @${username} not found.`);

        // Calculate new expiration
        const currentExp = user.subscriptionExp && user.subscriptionExp > new Date()
            ? user.subscriptionExp
            : new Date();

        const newExp = new Date(currentExp.getTime() + (days * 24 * 60 * 60 * 1000));

        await prisma.user.update({
            where: { id: user.id },
            data: { subscriptionExp: newExp }
        });

        // Format date for reply
        const dateStr = newExp.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        await ctx.reply(`✅ Extended @${username}'s plan by **${days} days**.\n📅 New Expiry: ${dateStr}`);
    });

    // BROADCAST
    bot.command('broadcast', async (ctx) => {
        const adminCheck = await isAdmin(ctx.from.id);
        if (!adminCheck.isAdmin) return ctx.reply('⛔ Access denied.');

        const message = ctx.message.text.replace('/broadcast ', '').trim();
        if (!message || message === '/broadcast') return ctx.reply('Usage: /broadcast Your message here');

        const users = await prisma.user.findMany({ where: { isBanned: false } });
        let sent = 0;

        for (const user of users) {
            try {
                await bot.telegram.sendMessage(Number(user.telegramId), `📢 **Announcement**\n\n${message}`);
                sent++;
            } catch (e) { /* User may have blocked bot */ }
        }

        await ctx.reply(`✅ Broadcast sent to ${sent}/${users.length} users.`);
    });

    // Admin action handlers
    bot.action('admin_stats', async (ctx) => {
        const adminCheck = await isAdmin(ctx.from.id);
        if (!adminCheck.isAdmin) return ctx.answerCbQuery('Access denied');

        const totalUsers = await prisma.user.count();
        const totalCases = await prisma.caseMatter.count();
        await ctx.answerCbQuery();
        await ctx.reply(`📊 Quick Stats: ${totalUsers} users, ${totalCases} cases`);
    });

    bot.action('admin_users', async (ctx) => {
        const adminCheck = await isAdmin(ctx.from.id);
        if (!adminCheck.isAdmin) return ctx.answerCbQuery('Access denied');

        await ctx.answerCbQuery();
        const users = await prisma.user.findMany({ take: 10, orderBy: { createdAt: 'desc' } });
        let msg = '👥 Recent Users:\n';
        users.forEach((u, i) => { msg += `${i + 1}. @${u.username || 'N/A'} (${u.subscription})\n`; });
        await ctx.reply(msg);
    });

    // ============= END ADMIN COMMANDS =============

    // Plan selection handlers with payment
    bot.action(/^plan_(FREE|PRO|FIRM|BAR)$/, async (ctx) => {
        const plan = ctx.match[1];
        const userId = ctx.from.id;

        await ctx.answerCbQuery();

        // Get user info
        const user = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) } });

        if (plan === 'FREE') {
            // Free plan - activate immediately
            await prisma.user.update({
                where: { telegramId: BigInt(userId) },
                data: { subscription: 'FREE', subscriptionExp: null }
            });
            return ctx.reply('✅ **FREE Plan Activated**\n\nYou now have access to:\n• 2 cases per month\n• Basic AI analysis\n• PDF export\n\nUpgrade anytime with /subscribe');
        }

        // Paid plans - generate payment link
        const amount = getPlanAmount(plan, 'NGN');
        const email = user?.email || `user${userId}@caseview.bot`;

        const payment = await initializePayment({
            email,
            amount,
            plan,
            telegramId: String(userId),
            currency: 'NGN'
        });

        if (payment.success && payment.url) {
            await ctx.reply(`💳 **Subscribe to ${plan} Plan**\n\n💰 Amount: ₦${amount.toLocaleString()}/month\n\n[Click here to pay](${payment.url})\n\nAfter payment, your plan will be activated automatically.`, { parse_mode: 'Markdown' });
        } else {
            await ctx.reply('❌ Payment initialization failed. Please try again or contact support.');
        }
    });

    // CAPTURE COMMAND - Photo/Video/Audio capture
    bot.command('capture', async (ctx) => {
        await ctx.reply('📸 **Media Capture**\n\nSelect what you want to capture for your case:\n\n• 📷 **Photo** - Take a picture of documents, evidence\n• 🎥 **Video** - Record video testimony or scene\n• 🎤 **Audio** - Record audio statement or notes\n\nTap a button below or simply send the media directly!', {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📷 Photo', callback_data: 'capture_photo' },
                        { text: '🎥 Video', callback_data: 'capture_video' }
                    ],
                    [
                        { text: '🎤 Audio', callback_data: 'capture_audio' },
                        { text: '📎 Document', callback_data: 'capture_doc' }
                    ]
                ]
            }
        });
    });

    // Capture action handlers
    bot.action('capture_photo', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply('📷 **Take a Photo**\n\nOpen your camera and take a picture.\nThen send it here directly.\n\nThe photo will be:\n• Analyzed by AI\n• Linked to your current case');
    });

    bot.action('capture_video', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply('🎥 **Record Video**\n\nTap the 📎 attachment button, select Camera, and record.\nThen send the video here.\n\nMax: 20MB | Supported: MP4, MOV');
    });

    bot.action('capture_audio', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply('🎤 **Record Audio**\n\nHold the 🎤 microphone button to record a voice message.\nOr send an audio file (MP3, WAV, M4A).\n\nAudio will be transcribed and added to your case.');
    });

    bot.action('capture_doc', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply('📎 **Upload Document**\n\nTap the 📎 attachment button and select a file.\nSupported: PDF, Word (DOC/DOCX), Images');
    });

    // OCR is now AUTOMATIC for all image uploads - no command needed

    bot.command('newbrief', (ctx) => {
        const userId = ctx.from.id;
        sessions[userId] = { step: 'WAITING_JURISDICTION', data: {} };
        ctx.reply('⚖️ **New Case Intake**\n\nLet\'s build your brief.\n\n1. First, what is the **Jurisdiction**? (e.g., NY, CA, Federal)');
    });

    bot.start(async (ctx) => {
        const from = ctx.from;
        if (!from) return;

        const payload = (ctx as any).startPayload; // Deep link parameter
        if (payload && payload.startsWith('invite_')) {
            const firmCode = payload.replace('invite_', '');
            const owner = await prisma.user.findFirst({ where: { firmCode } });
            if (owner) {
                // Show join confirmation
                const ownerName = owner.firmName || owner.branchName || owner.fullName || owner.username || 'this organization';
                return ctx.reply(`🤝 **Join ${ownerName}?**\n\nYou've been invited to join this organization as a staff member/member.\n\nBy joining, you will share the same Firm Code and your cases will be attributed to this organization.`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '✅ Confirm Join', callback_data: `confirm_join_${owner.id}` }],
                            [{ text: '❌ Cancel', callback_data: 'qa_done' }]
                        ]
                    }
                });
            }
        }

        // Create or Update User
        const user = await prisma.user.upsert({
            where: { telegramId: BigInt(from.id) },
            update: { username: from.username, firstName: from.first_name },
            create: {
                telegramId: BigInt(from.id),
                username: from.username,
                firstName: from.first_name,
                subscription: 'FREE'
            }
        });

        // Auto-register SUPER_ADMIN for @origichidiah with unlimited plan
        if (from.username === 'origichidiah') {
            await prisma.admin.upsert({
                where: { telegramId: BigInt(from.id) },
                update: { role: 'SUPER_ADMIN', username: from.username },
                create: { telegramId: BigInt(from.id), username: from.username, role: 'SUPER_ADMIN' }
            });
            // Set to BAR (unlimited) plan for SUPER_ADMIN
            await prisma.user.update({
                where: { telegramId: BigInt(from.id) },
                data: { subscription: 'BAR' }
            });
        }

        // Mock Trial Data
        const trialDaysLeft = 7;

        if (!user.firmCode) {
            sessions[Number(from.id)] = { step: 'WAITING_FIRM_CODE', data: {} };
            ctx.reply(`⚖️ **Welcome to CaseView Bot**\n\nTo organize your cases, please set a **Firm Code** (e.g., LGL, ABC, MYNAME).\n\nThis will prefix your cases (e.g. LGL-001). Enter it now:`);
            return;
        }

        ctx.reply(`⚖️ **CaseView Bot Legal Assistant**\n\nWelcome back, **${from.first_name}**!\n🆔 Firm Code: ${user.firmCode}\n💎 Plan: ${user.subscription} (Trial: ${trialDaysLeft} days left)\n\n**Quick Actions:**\n/newbrief - Start Guided Intake\n/history - View My Cases\n/search - Research Precedents\n/help - Show all commands`);
    });

    bot.command('history', async (ctx) => {
        const userId = ctx.from.id;
        const user = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) }, include: { cases: true } });

        if (!user || user.cases.length === 0) {
            return ctx.reply('No cases found. Start one with /newbrief');
        }

        ctx.reply(`📂 **My Case History**\nSelect a case to view, simulate, or delete:`, {
            reply_markup: {
                inline_keyboard: user.cases.slice(-5).map(c => [
                    { text: `📂 ${c.refCode || (`ID:${c.id}`)}`, callback_data: `view_case_${c.id}` },
                    { text: `🎲 Scenario`, callback_data: `scenario_case_${c.id}` },
                    { text: `🗑`, callback_data: `delete_case_${c.id}` }
                ])
            }
        });
    });

    // Case Management Handlers
    // Helper to escape Markdown special characters
    function escapeMd(text: string): string {
        return text.replace(/[_*[\]()`]/g, '\\$&');
    }

    bot.action(/^view_case_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        const c = await prisma.caseMatter.findUnique({ where: { id: caseId } });
        if (!c) return ctx.answerCbQuery('Case not found.');

        // Store case in session for Q&A
        const userId = ctx.from.id;
        sessions[userId] = sessions[userId] || { step: 'IDLE', data: {} };
        sessions[userId].data.currentCaseId = caseId;
        sessions[userId].data.currentRefCode = c.refCode || String(caseId);

        await ctx.answerCbQuery();
        let msg = `📂 **Case View: ${escapeMd(c.refCode || String(c.id))}**\n\n`;
        msg += `**Title:** ${escapeMd(c.title)}\n`;
        msg += `**Status:** ${escapeMd(c.status)}\n`;
        msg += `**Description:** ${escapeMd(c.description?.substring(0, 500) || 'No description')}...\n\n`;
        msg += `_Select an action below:_`;

        await ctx.replyWithMarkdown(msg, {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '❓ Ask Question', callback_data: `qa_case_${c.id}` },
                        { text: '🎲 Run Scenario', callback_data: `scenario_case_${c.id}` }
                    ],
                    [
                        { text: '🔍 Find Precedents', callback_data: `research_case_${c.id}` },
                        { text: '📤 Export', callback_data: `export_case_${c.id}` }
                    ],
                    [
                        { text: '🔙 Back to History', callback_data: 'refresh_history' },
                        { text: '🗑 Delete', callback_data: `delete_case_${c.id}` }
                    ]
                ]
            }
        });
    });

    bot.action(/^delete_case_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        await ctx.answerCbQuery();

        ctx.editMessageText(`⚠️ **Delete Case?**\n\nAre you sure you want to permanently delete this case? This action cannot be undone.`, {
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Yes, Delete', callback_data: `confirm_delete_${caseId}` },
                    { text: '❌ No, Cancel', callback_data: `view_case_${caseId}` }
                ]]
            }
        });
    });

    bot.action(/^confirm_delete_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        try {
            await prisma.caseMatter.delete({ where: { id: caseId } });
            await ctx.answerCbQuery('🗑 Case Deleted');
        } catch (e) {
            await ctx.answerCbQuery('Error deleting case.');
        }

        // Refresh history
        const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from.id) }, include: { cases: true } });
        ctx.editMessageText(`📂 **My Case History**\nSelect a case to view or delete:`, {
            reply_markup: {
                inline_keyboard: user?.cases.slice(-5).map(c => [
                    { text: `📂 ${c.refCode || (`ID:${c.id}`)}: ${c.title}`, callback_data: `view_case_${c.id}` },
                    { text: `🗑 Delete`, callback_data: `delete_case_${c.id}` }
                ]) || []
            }
        });
    });

    // Refresh History Handler
    bot.action('refresh_history', async (ctx) => {
        await ctx.answerCbQuery();
        // Trigger history command logic basically
        const userId = ctx.from.id;
        const user = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) }, include: { cases: true } });
        ctx.reply(`📂 **My Case History**\nSelect a case to view or delete:`, {
            reply_markup: {
                inline_keyboard: user?.cases.slice(-5).map(c => [
                    { text: `📂 ${c.refCode || (`ID:${c.id}`)}: ${c.title}`, callback_data: `view_case_${c.id}` },
                    { text: `🗑 Delete`, callback_data: `delete_case_${c.id}` }
                ]) || []
            }
        });
    });


    // Ask Question from History Case
    bot.action(/^qa_case_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        const c = await prisma.caseMatter.findUnique({ where: { id: caseId } });
        if (!c) return ctx.answerCbQuery('Case not found.');

        const userId = ctx.from.id;
        sessions[userId] = sessions[userId] || { step: 'IDLE', data: {} };
        sessions[userId].data.currentCaseId = caseId;
        sessions[userId].data.currentRefCode = c.refCode || String(caseId);
        sessions[userId].step = 'WAITING_QUESTION';

        await ctx.answerCbQuery();
        await ctx.reply(`❓ **Ask a Question about Case: ${c.refCode || c.id}**\n\nType your legal question below and I will analyze it based on this case's facts.`);
    });

    // Find Precedents from History Case
    bot.action(/^research_case_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        const c = await prisma.caseMatter.findUnique({ where: { id: caseId } });
        if (!c) return ctx.answerCbQuery('Case not found.');

        await ctx.answerCbQuery();
        await ctx.reply(`🔍 **Searching for precedents related to:** ${c.title}\n\nPlease wait...`);

        // Trigger search logic
        const results = await searchPrecedents(c.title + ' ' + (c.description?.substring(0, 200) || ''));
        if (results.length > 0) {
            let msg = `📚 **Precedents for Case: ${c.refCode || c.id}**\n\n`;
            results.slice(0, 5).forEach((r: any, i: number) => {
                msg += `${i + 1}. **${r.name}** (${r.court || 'Court N/A'})\n   ${r.snippet?.substring(0, 100) || 'No summary available'}...\n\n`;
            });
            await ctx.reply(msg + `\n_Use /search for more specific queries._`);
        } else {
            await ctx.reply(`No precedents found for this case's topic. Try /search [keywords] for a manual search.`);
        }
    });

    bot.command('share', async (ctx) => {
        const parts = ctx.message.text.split(' ');
        if (parts.length < 3) return ctx.reply('Usage: /share [CaseID] @username');

        const caseId = parts[1];
        const targetUser = parts[2];

        ctx.reply(`✅ **Access Granted**\n\nCase #${caseId} has been shared with ${targetUser}. They will receive a notification shortly.`);
        // --- Phase 4: Research Commands ---

    }); // End of /share command

    // --- Phase 4: Research Commands ---

    bot.command('search', async (ctx) => {
        const input = ctx.message.text.split(' ').slice(1).join(' ');
        if (!input) return ctx.reply('Usage: /search [keywords]');

        // Store query in session payload or encoding it in callback? 
        // Callback limit is 64 chars. If query is long, storing in session is safer.
        const userId = ctx.from.id;
        if (!sessions[userId]) sessions[userId] = { step: 'IDLE', data: {} };
        // We'll use a temp field or just pass it if short. Let's use session.staging temporarily for "search_query"
        // Hacky but works for MVP without new schema
        sessions[userId].staging = { type: 'text', content: input, mime: 'text/plain' };

        ctx.reply(`🔎 **Search: "${input}"**\nSelect Region/Jurisdiction:`, {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🇺🇸 US Cases', callback_data: 'search_region_US' },
                        { text: '🇳🇬 Nigeria', callback_data: 'search_region_NIGERIA' }
                    ],
                    [
                        { text: '🌍 Africa', callback_data: 'search_region_AFRICA' },
                        { text: '🇪🇺 Europe/UK', callback_data: 'search_region_EUROPE' }
                    ],
                    [
                        { text: '🌐 Global / WorldLII', callback_data: 'search_region_GLOBAL' }
                    ]
                ]
            }
        });
    });

    bot.action(/^search_region_(\w+)/, async (ctx) => {
        const region = ctx.match[1];
        const userId = ctx.from.id;
        const session = sessions[userId];
        const query = session?.staging?.content || 'legal research'; // Retrieve query

        try {
            await ctx.answerCbQuery(`Searching ${region}...`);
            await ctx.editMessageText(`🔎 **Searching ${region}...**\nQuery: "${query}"`);
        } catch (e) {
            // Ignore stale callback query errors
            console.log('[Bot] Stale callback, continuing...');
        }

        const results = await searchAllDatabases(query, false, { jurisdiction: region });

        let msg = `📚 **${region} Results**\n`;
        if (results.length === 0) msg += "_No direct results found. Try broader terms._\n";

        results.slice(0, 8).forEach((r, i) => {
            msg += `\n${i + 1}. **${escapeMd(r.name)}**\n   ${escapeMd(r.snippet.substring(0, 100))}...\n   [🔗 Open Link](${r.url})\n`;
        });

        await ctx.replyWithMarkdown(msg);
        // Clear staging
        if (session) session.staging = undefined;
    });

    bot.command('precedents', async (ctx) => {
        const query = ctx.message.text.split(' ').slice(1).join(' ');
        if (!query) return ctx.reply('Usage: /precedents [CaseID or keywords]');

        const results = await searchPrecedents(query);
        let msg = `🏛 **Top Precedents**\n`;
        results.slice(0, 3).forEach((r, i) => {
            msg += `\n${i + 1}. **${r.name}**\n   _${r.snippet}_\n`;
        });
        ctx.replyWithMarkdown(msg);
    });

    bot.command('scenario', async (ctx) => {
        const parts = ctx.message.text.split(' ');
        if (parts.length < 2) return ctx.reply('Usage: /scenario [CaseID]');

        const caseId = parseInt(parts[1]);
        const userCase = await prisma.caseMatter.findUnique({ where: { id: caseId } });

        if (!userCase || !userCase.description) return ctx.reply('Case not found or has no facts.');

        ctx.reply(`🎲 **Running AI Simulation for Case #${caseId}**\n\n_"${userCase.title}"_\n\nAnalyzing variations in Judge, Jury, and Evidence (This may take a moment)...`);

        const simulation = await aiService.runSimulation(userCase.description);

        ctx.replyWithMarkdown(`🔄 **Simulation Results**\n\n${simulation}`);
    });

    bot.command('help', (ctx) => {
        ctx.replyWithMarkdown(`
**🤖 CaseView Bot Commands**

*Core*
/start - Dashboard & Trial Info
/newbrief - Start Guided Intake
/history - View Saved Cases
/upload - Upload Documents (PDF/Img)

*Research*
/search "query" --jurisdiction=NY - Advanced Search
/precedents [query] - Find Case Law
/scenario [ID] - Run Outcome Simulator

*Tools*
/share [ID] @user - Share Case
/export [ID] - Download Brief
/subscribe - Upgrade Plan
        `);
    });

    // --- Phase 6: Utilities ---

    bot.command('export', async (ctx) => {
        const parts = ctx.message.text.split(' ');
        const userId = ctx.from.id;

        // If specific ID provided
        if (parts.length >= 2) {
            const caseId = parseInt(parts[1]);
            const userCase = await prisma.caseMatter.findUnique({ where: { id: caseId } });
            if (!userCase) return ctx.reply('Case not found.');
            return showExportMenu(ctx, userCase);
        }

        // Else show list
        const user = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) }, include: { cases: true } });
        if (!user || user.cases.length === 0) return ctx.reply('No cases to export.');

        ctx.reply(`📤 **Select Case to Export:**`, {
            reply_markup: {
                inline_keyboard: user.cases.slice(-5).map(c => [
                    { text: `📤 ${c.refCode || c.id}: ${c.title}`, callback_data: `pre_export_${c.id}` }
                ])
            }
        });
    });

    bot.action(/^pre_export_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        const c = await prisma.caseMatter.findUnique({ where: { id: caseId } });
        if (!c) return ctx.answerCbQuery('Error.');

        await ctx.answerCbQuery();
        showExportMenu(ctx, c);
    });

    function showExportMenu(ctx: any, c: any) {
        ctx.reply(`📄 **Export Case: ${c.refCode || c.id}**\nSelect format:`, {
            reply_markup: {
                inline_keyboard: [[
                    { text: '📄 PDF', callback_data: `export_pdf_${c.id}` },
                    { text: '📝 Word (.docx)', callback_data: `export_word_${c.id}` }
                ]]
            }
        });
    }

    bot.action(/^export_pdf_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        const c = await prisma.caseMatter.findUnique({ where: { id: caseId } });
        if (!c) return ctx.answerCbQuery('Error.');

        await ctx.answerCbQuery('Generating PDF...');

        // PDF Generation
        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument();
        const buffers: any[] = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            const pdfData = Buffer.concat(buffers);
            ctx.replyWithDocument({ source: pdfData, filename: `${c.refCode || 'Case'}_Brief.pdf` });
        });

        doc.fontSize(20).text(c.title, { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Reference: ${c.refCode || c.id}`);
        doc.text(`Status: ${c.status}`);
        doc.moveDown();
        doc.text(c.description || 'No description.');
        doc.end();
    });

    bot.action(/^export_word_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        const c = await prisma.caseMatter.findUnique({ where: { id: caseId } });
        if (!c) return ctx.answerCbQuery('Error.');

        await ctx.answerCbQuery('Generating Word Doc...');

        // Word Generation
        const { Document, Packer, Paragraph, TextRun } = require('docx');
        const doc = new Document({
            sections: [{
                properties: {},
                children: [
                    new Paragraph({
                        children: [new TextRun({ text: c.title, bold: true, size: 40 })],
                    }),
                    new Paragraph({
                        children: [new TextRun({ text: `Ref: ${c.refCode}`, size: 24 })],
                    }),
                    new Paragraph({
                        children: [new TextRun({ text: c.description || '', size: 24 })],
                    }),
                ],
            }],
        });

        const buffer = await Packer.toBuffer(doc);
        ctx.replyWithDocument({ source: buffer, filename: `${c.refCode || 'Case'}_Brief.docx` });
    });

    bot.command('subscribe', (ctx) => {
        ctx.reply('💎 **Upgrade to Pro**\n\nUnlock unlimited searches and export capabilities.\n\n[Pay $29.99/mo](https://t.me/CaseViewBot?start=subscribe_pro)');
    });

    // Helper to process input (text or file)
    const processCaseInput = async (ctx: any, textOrFile: { type: 'text' | 'file', content: string, mime?: string }, metadata?: any) => {
        const userId = ctx.from.id;

        await ctx.reply(`📋 **Analyzing Document...**\n\n• Reading content...\n• Identifying legal issues...\n• Searching relevant precedents...`);

        let facts = textOrFile.content;

        try {
            if (textOrFile.type === 'file') {
                facts = await extractTextFromDocument(textOrFile.content, textOrFile.mime || 'application/pdf');
                if (facts.startsWith('Error')) {
                    return ctx.reply(`⚠️ ${facts}\n\nPlease try a smaller file or different format.`);
                }
            }

            // Run AI Analysis first
            const analysis = await aiService.analyzeLegalText(facts);

            // Build search query from AI-extracted key terms (not raw document)
            const searchQuery = `${analysis.caseCategory} ${analysis.keyIssues.slice(0, 2).join(' ')}`.substring(0, 100);
            const research = await searchAllDatabases(searchQuery, true);

            // Format Output
            let response = `📄 **CASE BRIEF: ${analysis.caseCategory}**\n`;
            response += `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n`;
            response += `\n**📊 Viability Score: ${analysis.viabilityScore}/100**\n`;
            response += `*Prediction: ${analysis.prediction}*\n\n`;

            response += `**🔑 Key Issues**\n`;
            analysis.keyIssues.forEach(issue => response += `• ${issue}\n`);

            response += `\n**⚖️ Scenarios & Strategy**\n`;
            analysis.scenarios.forEach(s => {
                response += `\n**${s.name}** (${Math.round(s.probability * 100)}%)\n`;
                response += `_${s.description}_\n`;
                response += `👉 **Action:** ${s.recommendedAction}\n`;
            });

            response += `\n**📚 Precedent Search** (${research.length} found)\n`;
            research.slice(0, 3).forEach((r, i) => {
                response += `\n${i + 1}. [${r.source}] **${r.name}**\n   ${r.snippet.substring(0, 80)}...\n   [Read Case](${r.url})\n`;
            });

            // Append Smart Global Links
            response += getExtendedResearchLinks(facts.substring(0, 30)); // Search snippet

            // Upsert case to DB
            // Save to DB and store case ID in session
            let savedCaseId = 0;
            let savedRefCode = '';
            try {
                const user = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) }, include: { cases: true } });

                // Check monthly usage limit
                const limit = PLAN_LIMITS[user?.subscription || 'FREE'];
                const currentUsage = user?.monthlyUsage || 0;

                // Reset usage if month has passed
                const now = new Date();
                const resetDate = user?.usageResetDate || now;
                if (now.getMonth() !== resetDate.getMonth() || now.getFullYear() !== resetDate.getFullYear()) {
                    await prisma.user.update({
                        where: { telegramId: BigInt(userId) },
                        data: { monthlyUsage: 0, usageResetDate: now }
                    });
                } else if (currentUsage >= limit) {
                    // Limit reached
                    const nextReset = new Date(resetDate.getFullYear(), resetDate.getMonth() + 1, 1);
                    return ctx.reply(`❌ **Monthly Limit Reached**\n\nYou've used ${currentUsage}/${limit} cases on your ${user?.subscription} plan.\n\nUpgrade at /subscribe or wait until ${nextReset.toLocaleDateString()}.`);
                }

                // Generate Reference Code
                const count = user?.cases.length || 0;
                savedRefCode = user?.firmCode ? `${user.firmCode}-${String(count + 1).padStart(3, '0')}` : `CASE-${count + 1}`;

                const newCase = await prisma.caseMatter.create({
                    data: {
                        title: `${analysis.caseCategory} Case`,
                        description: facts.substring(0, 5000),
                        analysis: response, // Store full analysis for export
                        qaHistory: '[]', // Initialize empty Q&A history
                        status: 'OPEN',
                        userId: user?.id || 1,
                        refCode: savedRefCode
                    }
                });
                savedCaseId = newCase.id;

                // Increment usage and send warning if at 80%
                const newUsage = currentUsage + 1;
                await prisma.user.update({
                    where: { telegramId: BigInt(userId) },
                    data: { monthlyUsage: newUsage }
                });

                if (newUsage >= Math.floor(limit * 0.8) && newUsage < limit) {
                    await ctx.reply(`⚠️ **Usage Warning:** ${newUsage}/${limit} cases used this month.\n\nConsider upgrading at /subscribe`);
                }

                // Store in session for buttons to use
                sessions[userId] = sessions[userId] || { step: 'IDLE', data: {} };
                sessions[userId].data.currentCaseId = savedCaseId;
                sessions[userId].data.currentRefCode = savedRefCode;
                sessions[userId].data.facts = facts;
            } catch (e) { console.error("DB Save Fail", e); }

            // Store analysis in session for export
            if (!sessions[userId]) sessions[userId] = { step: 'IDLE', data: {} };
            sessions[userId].data.analysis = response;
            sessions[userId].data.currentCaseId = savedCaseId;
            sessions[userId].data.conversationHistory = [];

            // Send response with Inline Keyboard for Actions
            await ctx.replyWithMarkdown(response, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: `💾 Saved: ${savedRefCode}`, callback_data: `saved_${savedCaseId}` },
                            { text: '❓ Ask Question', callback_data: `ask_${savedCaseId}` }
                        ],
                        [
                            { text: '📤 Export', callback_data: `export_case_${savedCaseId}` },
                            { text: '🔗 Share', callback_data: `share_case_${savedCaseId}` }
                        ],
                        [
                            { text: '📎 Upload More', callback_data: `upload_more_${savedCaseId}` },
                            { text: '🎲 Scenario', callback_data: `scenario_case_${savedCaseId}` }
                        ],
                        [
                            { text: '🔗 Add Link', callback_data: `add_link_${savedCaseId}` }
                        ]
                    ]
                }
            });

            // Send precedent selection buttons if we have results
            if (research.length > 0) {
                // Store in session for lookup
                if (!sessions[userId]) sessions[userId] = { step: 'IDLE', data: {} };
                sessions[userId].data.precedents = research;

                const precedentButtons = research.slice(0, 3).map((r, i) => ([
                    { text: `📚 ${i + 1}. ${r.name.substring(0, 30)}`, callback_data: `analyze_prec_${savedCaseId}_${i}` }
                ]));

                await ctx.reply('📚 **Select a Precedent to Analyze**\n\nClick any case below to analyze how it applies to your matter:', {
                    reply_markup: {
                        inline_keyboard: precedentButtons
                    }
                });
            }

        } catch (processingError) {
            console.error('[Bot] Document processing failed:', processingError);
            await ctx.reply(`⚠️ Analysis failed. The document may be too large or complex.\n\nError: ${(processingError as any).message?.substring(0, 100)}`);
        }
    };

    // --- Action Handlers (Buttons) ---

    bot.action(/^saved_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        await ctx.answerCbQuery(`✅ Case #${caseId} Saved!`);
    });

    bot.action(/^ask_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        const userId = ctx.from.id;
        // Preserve the case context
        if (sessions[userId]) {
            sessions[userId].step = 'WAITING_QUESTION';
        } else {
            sessions[userId] = { step: 'WAITING_QUESTION', data: { currentCaseId: caseId } };
        }
        await ctx.answerCbQuery();
        await ctx.reply('❓ **What question do you have about this case?**\n\nI can analyze further or look for specific details.');
    });

    // Upload more documents to existing case
    bot.action(/^upload_more_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        const userId = ctx.from.id;

        // Store case context for appending
        if (!sessions[userId]) sessions[userId] = { step: 'IDLE', data: {} };
        sessions[userId].data.currentCaseId = caseId;

        await ctx.answerCbQuery();
        await ctx.reply('📎 **Upload More Documents**\n\nSend me another document (PDF, Word, or Image) to add to this case.\n\nThe new content will be appended to the existing analysis.');
    });

    // Export for specific case - show extent options first
    bot.action(/^export_case_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        await ctx.answerCbQuery();
        await ctx.reply(`📤 **Export Case #${caseId}**\n\nWhat would you like to include?`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📋 Full Report (All)', callback_data: `exp_full_${caseId}` }],
                    [{ text: '📊 Analysis Only', callback_data: `exp_analysis_${caseId}` }],
                    [{ text: '❓ Q&A History Only', callback_data: `exp_qa_${caseId}` }],
                    [{ text: '❌ Cancel', callback_data: 'qa_done' }]
                ]
            }
        });
    });

    // Export extent handlers
    bot.action(/^exp_(full|analysis|qa)_(\d+)/, async (ctx) => {
        const extent = ctx.match[1];
        const caseId = parseInt(ctx.match[2]);
        await ctx.answerCbQuery();
        await ctx.reply(`Select format for ${extent === 'full' ? 'Full Report' : extent === 'analysis' ? 'Analysis' : 'Q&A'}:`, {
            reply_markup: {
                inline_keyboard: [[
                    { text: '📄 PDF', callback_data: `export_pdf_${extent}_${caseId}` },
                    { text: '📝 Word', callback_data: `export_word_${extent}_${caseId}` }
                ]]
            }
        });
    });

    // Actual PDF/Word export with extent
    bot.action(/^export_(pdf|word)_(full|analysis|qa)_(\d+)/, async (ctx) => {
        const format = ctx.match[1];
        const extent = ctx.match[2] as 'full' | 'analysis' | 'qa';
        const caseId = parseInt(ctx.match[3]);
        const userId = ctx.from.id;

        await ctx.answerCbQuery('Generating export...');
        await ctx.reply(`📄 Generating ${format.toUpperCase()} export...`);

        try {
            const c = await prisma.caseMatter.findUnique({ where: { id: caseId } });
            if (!c) {
                return ctx.reply('Case not found.');
            }

            const session = sessions[userId];

            // Parse Q&A history from database (JSON string)
            let qaHistory: Array<{ role: 'user' | 'bot', content: string }> = [];
            try {
                if (c.qaHistory) {
                    qaHistory = JSON.parse(c.qaHistory);
                }
            } catch (e) { console.error('Failed to parse qaHistory:', e); }

            // Prepare export data from DATABASE (not session)
            const exportData = {
                refCode: c.refCode || `CASE-${c.id}`,
                title: c.title,
                status: c.status,
                analysis: c.analysis || c.description || '', // Use database analysis
                conversationHistory: qaHistory // Use database Q&A history
            };

            let buffer: Buffer;
            let filename: string;
            let mimeType: string;

            if (format === 'pdf') {
                buffer = await generatePDF(exportData, extent);
                filename = `case_${c.refCode || caseId}_${extent}.pdf`;
                mimeType = 'application/pdf';
            } else {
                buffer = await generateWord(exportData, extent);
                filename = `case_${c.refCode || caseId}_${extent}.docx`;
                mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            }

            // Send the file
            await ctx.replyWithDocument({
                source: buffer,
                filename
            });

            await ctx.reply(`✅ **Export Complete**\n\nFile: ${filename}\nFormat: ${format.toUpperCase()}\nContent: ${extent === 'full' ? 'Full Report' : extent === 'analysis' ? 'Analysis Only' : 'Q&A Only'}`);

        } catch (e) {
            console.error('Export error:', e);
            await ctx.reply(`Export failed: ${(e as Error).message?.substring(0, 100) || 'Unknown error'}`);
        }
    });

    // Share for specific case
    bot.action(/^share_case_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        const userId = ctx.from.id;

        // Store case ID for sharing flow
        if (sessions[userId]) sessions[userId].data.currentCaseId = caseId;

        await ctx.answerCbQuery();
        await ctx.reply(`📤 **Share Case #${caseId}**\n\nHow would you like to share?`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📱 Send to Telegram User', callback_data: 'share_telegram' }],
                    [{ text: '📧 Get Shareable Summary', callback_data: 'share_external' }],
                    [{ text: '❌ Cancel', callback_data: 'qa_done' }]
                ]
            }
        });
    });

    // Scenario from history
    // SCENARIO SIMULATION HANDLER - Starts interactive wizard
    bot.action(/^scenario_case_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        const userId = ctx.from.id;

        const c = await prisma.caseMatter.findUnique({ where: { id: caseId } });
        if (!c || !c.description) return ctx.answerCbQuery('Case not found.');

        // Initialize Wizard
        if (!sessions[userId]) sessions[userId] = { step: 'IDLE', data: {} };
        sessions[userId].step = 'SCENARIO_Q1';
        sessions[userId].data.currentCaseId = caseId;
        sessions[userId].data.facts = c.description;
        sessions[userId].data.scenarioInputs = {}; // Reset

        await ctx.answerCbQuery();
        await ctx.reply(`🎲 **Interactive Scenario Wizard**\n\nI will ask 5 questions to customize your simulation.\n\n1️⃣ **Define the specific TARGET OUTCOME you want to test?**\n(e.g., "Full acquittal", "Settlement under $50k", "Custody granted")`);
    });

    // SCENARIO SIMULATION HANDLER
    bot.action(/^scenario_case_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);

        await ctx.answerCbQuery('Generating scenarios...');
        await ctx.reply('🎲 **Generating Case Scenarios...**\n\nAnalyzing possible outcomes...');

        try {
            // Get case details
            const caseData = await prisma.caseMatter.findUnique({ where: { id: caseId } });
            if (!caseData) {
                return ctx.reply('❌ Case not found.');
            }

            // Use AI to generate scenarios
            const prompt = `Based on this legal case, generate 3 possible outcome scenarios with probabilities:

Case: ${caseData.title}
Details: ${caseData.description?.substring(0, 2000) || 'No details'}
Analysis: ${caseData.analysis?.substring(0, 1000) || 'No analysis'}

For each scenario, provide:
1. Scenario name
2. Probability (%)
3. Description (2-3 sentences)
4. Recommended action

Format as:
**Scenario 1: [Name]** (XX% likely)
[Description]
👉 Action: [What to do]

---`;

            const scenarios = await aiService.askAI(prompt, 'Generate case outcome scenarios');

            // Save scenarios to database
            await prisma.caseMatter.update({
                where: { id: caseId },
                data: { scenarios: scenarios } as any
            });

            const buttons = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '❓ Ask More', callback_data: `ask_${caseId}` },
                            { text: '📤 Export', callback_data: `export_case_${caseId}` }
                        ]
                    ]
                }
            };

            // Try with markdown, fallback to plain text
            try {
                await ctx.reply(`🎲 **Case Scenario Analysis**\n\n${scenarios}`, { parse_mode: 'Markdown', ...buttons });
            } catch (markdownError) {
                console.error('Markdown parse error in scenario, sending plain');
                await ctx.reply(`🎲 Case Scenario Analysis\n\n${scenarios}`, buttons);
            }
        } catch (error) {
            console.error('Scenario generation error:', error);
            await ctx.reply('❌ Failed to generate scenarios. Please try again.');
        }
    });

    // ANALYZE PRECEDENT WITH CURRENT CASE
    bot.action(/^analyze_prec_(\d+)_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        const index = parseInt(ctx.match[2]);
        const userId = ctx.from.id;
        const session = sessions[userId];

        if (!session?.data?.precedents?.[index]) {
            return ctx.reply('⚠️ Session expired or precedent not found. Please search again.');
        }

        const precedent = session.data.precedents[index];
        const precedentUrl = precedent.url;

        await ctx.answerCbQuery('Analyzing precedent...');
        await ctx.reply('📚 **Analyzing Precedent...**\n\nComparing selected case with your matter...');

        try {
            // Get current case
            const caseData = await prisma.caseMatter.findUnique({ where: { id: caseId } });
            if (!caseData) {
                return ctx.reply('❌ Case not found.');
            }

            // Use AI to analyze the precedent relevance
            const prompt = `Analyze how this precedent case applies to the current legal matter:

CURRENT CASE:
Title: ${caseData.title}
Details: ${caseData.description?.substring(0, 1500) || 'No details'}

PRECEDENT TO ANALYZE:
URL: ${precedentUrl}

Provide:
1. **Relevance Score** (1-10)
2. **Key Similarities** (3-4 points)
3. **Key Differences** (2-3 points)
4. **How to Apply This Precedent** (strategic advice)
5. **Potential Distinguishing Arguments** (if opposing counsel cites this)`;

            const analysis = await aiService.askAI(prompt, 'Analyze precedent relevance');

            const buttons = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '❓ Ask More', callback_data: `ask_${caseId}` },
                            { text: '🔗 Open Case', url: precedentUrl }
                        ]
                    ]
                }
            };

            try {
                await ctx.reply(`📚 **Precedent Analysis**\n\n${analysis}`, { parse_mode: 'Markdown', ...buttons });
            } catch (e) {
                await ctx.reply(`📚 Precedent Analysis\n\n${analysis}`, buttons);
            }

        } catch (error) {
            console.error('Precedent analysis error:', error);
            await ctx.reply('❌ Failed to analyze precedent. Please try again.');
        }
    });

    // Subscription Plan Handlers
    bot.action(/^plan_(FREE|PRO|FIRM|BAR)/, async (ctx) => {
        const plan = ctx.match[1];
        const userId = ctx.from.id;
        const prices: Record<string, string> = { FREE: '$0', PRO: '$8', FIRM: '$49', BAR: '$199' };
        const limits: Record<string, string> = { FREE: '2', PRO: '10', FIRM: '20', BAR: 'Unlimited' };

        if (plan === 'FREE') {
            await prisma.user.update({
                where: { telegramId: BigInt(userId) },
                data: { subscription: 'FREE', subscriptionExp: null }
            });
            await ctx.answerCbQuery('Switched to FREE plan');
            await ctx.editMessageText(`✅ You are now on the **FREE** plan.\n\n• ${limits.FREE} cases/month\n• Basic analysis\n• PDF export`);
        } else {
            // For paid plans, show payment info
            const planName = plan === 'BAR' ? 'BAR ASSOCIATION' : plan;
            await ctx.answerCbQuery();

            // Star Prices
            const starsMap: Record<string, number> = { PRO: 500, FIRM: 2500, BAR: 10000 };
            const stars = starsMap[plan] || 500;

            await ctx.reply(`💳 **Upgrade to ${planName}**\n\n**Features:**\n• ${limits[plan]} cases/month\n${plan === 'FIRM' || plan === 'BAR' ? '• Team management\n' : ''}${plan === 'BAR' ? '• Unlimited members\n• API access\n' : ''}\n\nSelect payment method:`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `⭐ Pay ${stars} Stars`, callback_data: `pay_stars_${plan}` }],
                        [{ text: `💳 Card / Bank Transfer (${prices[plan]})`, url: 'https://paystack.com/pay/caseview-' + plan.toLowerCase() }]
                    ]
                }
            });
        }
    });

    // STARS PAYMENT HANDLERS
    bot.action(/^pay_stars_(PRO|FIRM|BAR)/, async (ctx) => {
        const plan = ctx.match[1];
        const starsMap: Record<string, number> = { PRO: 500, FIRM: 2500, BAR: 10000 };
        const price = starsMap[plan];

        await ctx.answerCbQuery();
        await ctx.sendInvoice({
            title: `${plan} Plan Subscription`,
            description: `Monthly subscription for ${plan} plan features.`,
            payload: `sub_${plan}_${ctx.from.id}`,
            provider_token: "", // Empty for Telegram Stars
            currency: "XTR",
            prices: [{ label: `${plan} Plan`, amount: price }],
            start_parameter: "upgrade-plan"
        });
    });

    // Handle Pre-Checkout (Required for Stars)
    bot.on('pre_checkout_query', async (ctx) => {
        await ctx.answerPreCheckoutQuery(true);
    });

    // Handle Successful Payment
    bot.on('successful_payment', async (ctx) => {
        if (!ctx.message || !('successful_payment' in ctx.message)) return;

        const payment = ctx.message.successful_payment;
        const payload = payment.invoice_payload; // e.g., sub_PRO_12345

        if (payload.startsWith('sub_')) {
            const parts = payload.split('_');
            const plan = parts[1];
            const userId = ctx.from.id;

            // Activate Plan
            await prisma.user.update({
                where: { telegramId: BigInt(userId) },
                data: {
                    subscription: plan,
                    subscriptionExp: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // +30 days
                } as any
            });

            await ctx.reply(`🎉 **Payment Successful!**\n\nYou have been upgraded to the **${plan}** plan.\n\nThank you for subscribing!`);
        }
    });

    // Edit Profile Field Handlers
    bot.action(/^edit_(fullName|email|phone|address|jobPosition|firmCode)/, async (ctx) => {
        const field = ctx.match[1];
        const userId = ctx.from.id;
        const fieldNames: Record<string, string> = {
            fullName: 'Full Name',
            email: 'Email',
            phone: 'Phone Number',
            address: 'Address',
            jobPosition: 'Job Position',
            firmCode: 'Firm Code'
        };

        if (!sessions[userId]) sessions[userId] = { step: 'IDLE', data: {} };
        sessions[userId].step = `EDIT_${field.toUpperCase()}` as any;

        await ctx.answerCbQuery();
        await ctx.reply(`✏️ Enter your new **${fieldNames[field]}**:`);
    });

    // Delete Account Confirmation
    bot.action('confirm_delete_account', async (ctx) => {
        const userId = ctx.from.id;

        try {
            // Delete all user's cases first
            const user = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) } });
            if (user) {
                await prisma.caseMatter.deleteMany({ where: { userId: user.id } });
                await prisma.user.delete({ where: { id: user.id } });
            }

            // Clear session
            delete sessions[userId];

            await ctx.answerCbQuery('Account Deleted');
            await ctx.editMessageText('🗑 **Account Deleted**\n\nYour account and all data have been permanently removed.\n\nUse /start to create a new account.');
        } catch (e) {
            await ctx.answerCbQuery('Error deleting account');
            await ctx.reply('Error deleting account. Please try again.');
        }
    });

    bot.action('share_action', async (ctx) => {
        const userId = ctx.from.id;
        await ctx.answerCbQuery();

        // Show sharing options
        await ctx.reply('📤 **Share Case**\n\nHow would you like to share?', {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📱 Send to Telegram User', callback_data: 'share_telegram' },
                    ],
                    [
                        { text: '📧 Copy Link for Email/External', callback_data: 'share_external' }
                    ],
                    [
                        { text: '❌ Cancel', callback_data: 'qa_done' }
                    ]
                ]
            }
        });
    });

    bot.action('share_telegram', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply('👤 Enter the @username of the Telegram user to share with:\n\nExample: @colleague');
        // Set session to wait for username input
        const userId = ctx.from.id;
        if (!sessions[userId]) sessions[userId] = { step: 'IDLE', data: {} };
        sessions[userId].step = 'WAITING_SHARE_USER';
    });

    bot.action('share_external', async (ctx) => {
        const userId = ctx.from.id;
        const session = sessions[userId];
        const caseId = session?.data?.currentCaseId;

        await ctx.answerCbQuery();

        if (caseId) {
            const c = await prisma.caseMatter.findUnique({ where: { id: caseId } });
            if (c) {
                const summary = `📋 **Case Brief: ${c.refCode}**\n\n**Title:** ${c.title}\n**Status:** ${c.status}\n\n**Summary:**\n${c.description?.substring(0, 500) || 'No description'}\n\n_Generated by CaseView Bot_`;
                await ctx.reply(`📧 **Shareable Summary**\n\nCopy and send via email/WhatsApp:\n\n---\n${summary}\n---`);
            } else {
                await ctx.reply('Case not found.');
            }
        } else {
            await ctx.reply('No case selected. Use /history to select a case first.');
        }
    });

    bot.action('export_action', async (ctx) => {
        const userId = ctx.from.id;
        const user = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) }, include: { cases: { take: 5, orderBy: { id: 'desc' } } } });

        if (!user || user.cases.length === 0) {
            return ctx.answerCbQuery('No cases to export.');
        }

        await ctx.answerCbQuery();

        // Show recent cases to export
        await ctx.reply('📤 **Select Case to Export:**', {
            reply_markup: {
                inline_keyboard: user.cases.map(c => [
                    { text: `📄 ${c.refCode || c.id}: ${c.title?.substring(0, 25) || 'Case'}`, callback_data: `pre_export_${c.id}` }
                ])
            }
        });
    });

    bot.action('qa_done', async (ctx) => {
        const userId = ctx.from.id;
        if (sessions[userId]) sessions[userId].step = 'IDLE';
        await ctx.answerCbQuery('Chat Closed');
        await ctx.editMessageText('✅ **Conversation Closed.**\nUse /history to view cases or /search for research.');
    });

    bot.action(/^confirm_join_(\d+)/, async (ctx) => {
        const ownerId = parseInt(ctx.match[1]);
        const userId = ctx.from.id;

        try {
            const owner = await prisma.user.findUnique({ where: { id: ownerId }, include: { teamMembers: true } });
            if (!owner) return ctx.answerCbQuery('Organization not found.');

            // Check staff limit
            const staffLimit = owner.subscription === 'BAR' ? 100 : 15;
            if ((owner.teamMembers?.length || 0) >= staffLimit) {
                return ctx.reply(`❌ This organization has reached its staff limit (${staffLimit}).`);
            }

            // Link user to owner
            await prisma.user.update({
                where: { telegramId: BigInt(userId) },
                data: {
                    teamOwnerId: ownerId,
                    firmCode: owner.firmCode,
                    accountType: owner.accountType === 'FIRM' ? 'FIRM' : 'BAR', // Join as part of that type
                    subscription: owner.subscription
                } as any
            });

            await ctx.answerCbQuery('Joined successfully!');
            await ctx.editMessageText(`✅ **Welcome to the Team!**\n\nYou have joined **${owner.firmName || owner.branchName || 'the organization'}**.\n\nYou can now create cases using the organization's reference code: **${owner.firmCode}**.\n\nUse /newbrief to start.`);
        } catch (e) {
            console.error('Join error:', e);
            await ctx.answerCbQuery('Failed to join.');
        }
    });

    // Wizard Step Handler
    bot.on('text', async (ctx) => {
        const userId = ctx.from.id;
        const session = sessions[userId];
        const text = ctx.message.text;

        if (!session || session.step === 'IDLE') {
            if (text.startsWith('/')) return; // Ignore other commands
            return ctx.reply('Please use /newbrief to start a new case or /search to research.');
        }

        switch (session.step) {
            case 'WAITING_FIRM_CODE':
                const code = text.toUpperCase().substring(0, 5);
                await prisma.user.update({
                    where: { telegramId: BigInt(userId) },
                    data: { firmCode: code }
                });
                session.step = 'IDLE';
                ctx.reply(`✅ **Code Set:** ${code}\n\nYour future cases will be referenced as **${code}-XXX**.\n\nUse /newbrief to start.`);
                return;

            // FIRM SIGNUP FLOW
            case 'SIGNUP_FIRM_NAME':
                await prisma.user.update({
                    where: { telegramId: BigInt(userId) },
                    data: { firmName: text }
                });
                session.step = 'SIGNUP_FIRM_STATE';
                await ctx.reply('🏢 Step 2/6: What **State** is your firm located in?');
                return;

            case 'SIGNUP_FIRM_STATE':
                await prisma.user.update({
                    where: { telegramId: BigInt(userId) },
                    data: { firmState: text }
                });
                session.step = 'SIGNUP_NAME';
                await ctx.reply('🏢 Step 3/6: What is your **Full Name**?');
                return;

            // BAR ASSOCIATION SIGNUP FLOW
            case 'SIGNUP_BRANCH_NAME':
                await prisma.user.update({
                    where: { telegramId: BigInt(userId) },
                    data: { branchName: text }
                });
                session.step = 'SIGNUP_NAME';
                await ctx.reply('⚖️ Step 2/6: What is your **Full Name**?');
                return;

            // SCENARIO WIZARD FLOW
            case 'SCENARIO_Q1':
                session.data.scenarioInputs = session.data.scenarioInputs || {};
                session.data.scenarioInputs.outcome = text;
                session.step = 'SCENARIO_Q2';
                await ctx.reply('2️⃣ **What KEY EVIDENCE or witness testimony should be considered?**\n(e.g., "Email dated Jan 4th", "Testimony of Mr. Smith")');
                return;

            case 'SCENARIO_Q2':
                session.data.scenarioInputs!.evidence = text;
                session.step = 'SCENARIO_Q3';
                await ctx.reply('3️⃣ **What is the OPPOSING COUNSEL\'S primary argument?**\n(e.g., "Statute of limitations", "Lack of intent")');
                return;

            case 'SCENARIO_Q3':
                session.data.scenarioInputs!.opposing = text;
                session.step = 'SCENARIO_Q4';
                await ctx.reply('4️⃣ **Any JURISDICTION or JUDGE specific nuances?**\n(e.g., "NY State Court", "Conservative Judge", "Federal Circuit")');
                return;

            case 'SCENARIO_Q4':
                session.data.scenarioInputs!.jurisdiction = text;
                session.step = 'SCENARIO_Q5';
                await ctx.reply('5️⃣ **CAVEATS & COMMENTS: Any other considerations?**\n(e.g., "Client has no criminal record", "Budget is tight")');
                return;

            case 'SCENARIO_Q5':
                session.data.scenarioInputs!.caveats = text;
                session.step = 'IDLE'; // Wizard complete

                // RUN SIMULATION
                await ctx.reply('🎲 **Running Custom Simulation...**\nAnalyzing your 5 parameters against case facts...');

                if (!session.data.facts || !session.data.scenarioInputs) return ctx.reply('Error: Missing data.');

                try {
                    const simulation = await aiService.runInteractiveSimulation(session.data.facts, session.data.scenarioInputs as any);
                    const caseId = session.data.currentCaseId;

                    if (caseId) {
                        await prisma.caseMatter.update({
                            where: { id: caseId },
                            data: { scenarios: simulation } as any
                        });
                    }

                    const MAX_LENGTH = 4000;
                    const buttons = {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '💾 Save', callback_data: `saved_${caseId}` },
                                    { text: '❓ Ask Question', callback_data: `ask_${caseId}` }
                                ],
                                [
                                    { text: '🔗 Share', callback_data: `share_case_${caseId}` },
                                    { text: '📤 Export', callback_data: `export_case_${caseId}` }
                                ],
                                [
                                    { text: '🔗 Add Link', callback_data: `add_link_${caseId}` }
                                ],
                                [
                                    { text: '✅ Done', callback_data: 'qa_done' }
                                ]
                            ]
                        }
                    };

                    if (simulation.length <= MAX_LENGTH) {
                        await ctx.reply(`🔄 **Custom Simulation Results**\n\n${simulation}`, buttons);
                    } else {
                        // Split long message
                        const parts = simulation.match(/[\s\S]{1,4000}/g) || [];
                        for (let i = 0; i < parts.length; i++) {
                            const isLast = i === parts.length - 1;
                            const opts = isLast ? buttons : {};

                            // Add header to first part
                            const text = i === 0 ? `🔄 **Custom Simulation Results**\n\n${parts[i]}` : parts[i];
                            await ctx.reply(text, opts);
                        }
                    }
                } catch (err) {
                    console.error('Simulation error:', err);
                    await ctx.reply('⚠️ Simulation failed.');
                }
                return;

            case 'EXPORT_WORDS':
                session.data.exportSettings!.wordCount = text;
                session.step = 'IDLE';

                const expCaseId = session.data.currentCaseId;
                if (!expCaseId) return ctx.reply('Error: Case ID lost.');

                await ctx.reply('⚙️ Generating document with your settings...');

                // Call Export Generation
                const expFormat = session.data.exportSettings!.format;
                const cExp = await prisma.caseMatter.findUnique({ where: { id: expCaseId } });

                if (!cExp) return ctx.reply('Case not found.');

                try {
                    const exportData = {
                        refCode: cExp.refCode || 'N/A',
                        title: cExp.title,
                        status: cExp.status,
                        analysis: cExp.analysis || '',
                        conversationHistory: cExp.qaHistory ? JSON.parse(cExp.qaHistory) : [],
                        scenarios: cExp.scenarios || ''
                    };

                    let filePath: any;
                    if (expFormat === 'Word') {
                        filePath = await generateWord(exportData, 'full');
                    } else {
                        filePath = await generatePDF(exportData, 'full');
                    }

                    if (session.data.exportSettings?.wordCount && session.data.exportSettings.wordCount.toLowerCase() !== 'default') {
                        await ctx.reply(`⚠️ Note: Exporting full analysis. Word count limit (${session.data.exportSettings.wordCount}) noted for future AI summarization features.`);
                    }

                    await ctx.replyWithDocument({ source: filePath, filename: `Case_${cExp.refCode}.${expFormat === 'Word' ? 'docx' : 'pdf'}` });
                    await ctx.reply('✅ Export Complete.');
                } catch (e) {
                    console.error('Export failed:', e);
                    await ctx.reply('❌ Generation failed.');
                }
                return;

            case 'WAITING_LINK':
                // Check if valid URL
                if (!text.startsWith('http')) return ctx.reply('Please enter a valid URL (starting with http/https).');

                await ctx.reply('🔗 **Processing Link...**\nReading content from URL...');
                try {
                    // Try to extract - extraction service handles axios for file types
                    // We treat it as a document download
                    const content = await extractTextFromDocument(text, 'application/pdf'); // Default mime hint, extractor decides

                    // Append to description
                    const caseId = session.data.currentCaseId;
                    if (caseId) {
                        const existing = await prisma.caseMatter.findUnique({ where: { id: caseId } });
                        await prisma.caseMatter.update({
                            where: { id: caseId },
                            data: { description: (existing?.description || '') + `\n\n[Custom Link Content]: ${content}` }
                        });
                        session.data.facts = (existing?.description || '') + `\n\n[Custom Link Content]: ${content}`;

                        await ctx.reply('✅ **Link Content Added.**\nCase facts updated. You can now run a new analysis or scenario.');
                    }
                } catch (e) {
                    await ctx.reply('❌ Failed to read link. Ensure it is a direct link to a PDF, Word doc, or Image.');
                }
                session.step = 'IDLE';
                return;


            case 'WAITING_QUESTION':
                // KEEP SESSION ACTIVE (Loop)
                await ctx.reply('🤖 Analyzing your question against case facts...');
                const context = session.data.facts || "No facts provided yet.";
                const answer = await aiService.askAI(context, text);

                // Store Q&A in conversation history for export
                if (!session.data.conversationHistory) session.data.conversationHistory = [];
                session.data.conversationHistory.push({ role: 'user', content: text, timestamp: new Date() });
                session.data.conversationHistory.push({ role: 'bot', content: answer, timestamp: new Date() });

                // Persist Q&A to database
                const currentCaseId = session.data.currentCaseId || 0;
                if (currentCaseId > 0) {
                    try {
                        const caseData = await prisma.caseMatter.findUnique({ where: { id: currentCaseId } });
                        const existingHistory = caseData?.qaHistory ? JSON.parse(caseData.qaHistory) : [];
                        existingHistory.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
                        existingHistory.push({ role: 'bot', content: answer, timestamp: new Date().toISOString() });
                        await prisma.caseMatter.update({
                            where: { id: currentCaseId },
                            data: { qaHistory: JSON.stringify(existingHistory) }
                        });
                    } catch (e) { console.error('Failed to persist Q&A:', e); }
                }

                // Send answer with fallback if markdown fails
                const buttons = {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '❓ Ask More', callback_data: `ask_${currentCaseId}` },
                                { text: '🎲 Scenario', callback_data: `scenario_case_${currentCaseId}` }
                            ],
                            [
                                { text: '📤 Export', callback_data: `export_case_${currentCaseId}` },
                                { text: '🔗 Share', callback_data: `share_case_${currentCaseId}` }
                            ],
                            [{ text: '✅ Done', callback_data: 'qa_done' }]
                        ]
                    }
                };

                try {
                    await ctx.reply(`**${answer}**`, { parse_mode: 'Markdown', ...buttons });
                } catch (markdownError) {
                    // Fallback to plain text if markdown parsing fails
                    console.error('Markdown parse error, sending as plain text:', markdownError);
                    await ctx.reply(answer, buttons);
                }
                return;

            case 'WAITING_SHARE_USER':
                // User entered a @username to share with
                const shareUsername = text.startsWith('@') ? text : `@${text}`;
                const shareCaseId = session.data.currentCaseId;

                if (shareCaseId) {
                    const caseToShare = await prisma.caseMatter.findUnique({ where: { id: shareCaseId } });
                    if (caseToShare) {
                        await ctx.reply(`✅ **Sharing Instructions**\n\nForward the case brief below to ${shareUsername}:\n\n📋 **${caseToShare.refCode}: ${caseToShare.title}**\n${caseToShare.description?.substring(0, 300)}...\n\n_Or use Export to send as PDF/Word_`);
                    }
                } else {
                    await ctx.reply('No case selected to share.');
                }
                session.step = 'IDLE';
                return;

            // EDIT PROFILE HANDLERS
            case 'EDIT_FULLNAME':
            case 'EDIT_EMAIL':
            case 'EDIT_PHONE':
            case 'EDIT_ADDRESS':
            case 'EDIT_JOBPOSITION':
            case 'EDIT_FIRMCODE':
                const fieldMap: Record<string, string> = {
                    'EDIT_FULLNAME': 'fullName',
                    'EDIT_EMAIL': 'email',
                    'EDIT_PHONE': 'phone',
                    'EDIT_ADDRESS': 'address',
                    'EDIT_JOBPOSITION': 'jobPosition',
                    'EDIT_FIRMCODE': 'firmCode'
                };
                const dbField = fieldMap[session.step];
                await prisma.user.update({
                    where: { telegramId: BigInt(userId) },
                    data: { [dbField]: text }
                });
                session.step = 'IDLE';
                await ctx.reply(`✅ **${dbField}** updated successfully!\n\nUse /profile to view your updated info.`);
                return;

            // ADD STAFF HANDLER
            case 'WAITING_ADDSTAFF':
                const staffUsername = text.startsWith('@') ? text.substring(1) : text;
                const staffUser = await prisma.user.findFirst({ where: { username: staffUsername } });

                if (!staffUser) {
                    await ctx.reply(`❌ User @${staffUsername} not found.\n\nThey must have started the bot first. Ask them to run /start`);
                    return;
                }

                if (staffUser.teamOwnerId) {
                    await ctx.reply(`❌ @${staffUsername} is already part of another team.`);
                    session.step = 'IDLE';
                    return;
                }

                const owner = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) } });
                await prisma.user.update({
                    where: { id: staffUser.id },
                    data: { teamOwnerId: owner?.id }
                });

                session.step = 'IDLE';
                await ctx.reply(`✅ **@${staffUsername}** added to your team!\n\nThey now have access to shared team features.\n\nUse /team to view all members.`);
                return;

            // OCR EDIT - User sending corrected text
            case 'OCR_EDIT':
                session.data.ocrText = text;
                session.step = 'IDLE';
                await ctx.reply('✅ **Text Updated!**\n\nYour corrected text is ready.', {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ Use for New Case', callback_data: 'ocr_use_new' },
                                { text: '📋 Copy Text', callback_data: 'ocr_copy' }
                            ],
                            [{ text: '❌ Discard', callback_data: 'ocr_discard' }]
                        ]
                    }
                });
                return;

            // SIGNUP WIZARD STEPS
            case 'SIGNUP_NAME':
                await prisma.user.update({
                    where: { telegramId: BigInt(userId) },
                    data: { fullName: text }
                });
                session.step = 'SIGNUP_EMAIL';
                await ctx.reply('📧 Please enter your **Email Address**:');
                return;

            case 'SIGNUP_EMAIL':
                if (!text.includes('@')) return ctx.reply('❌ Invalid email. Please try again.');

                await prisma.user.update({
                    where: { telegramId: BigInt(userId) },
                    data: { email: text }
                });

                session.step = 'SIGNUP_PHONE';
                await ctx.reply('📱 Please enter your **Phone Number** (with Country Code, e.g., +234...):');
                return;

            case 'SIGNUP_PHONE':
                await prisma.user.update({
                    where: { telegramId: BigInt(userId) },
                    data: { phone: text }
                });

                session.step = 'SIGNUP_COUNTRY';
                await ctx.reply('🌍 Please enter your **Country**:');
                return;

            case 'SIGNUP_COUNTRY':
                await prisma.user.update({
                    where: { telegramId: BigInt(userId) },
                    data: { address: text } // Using address field for Country for now
                });

                // Show completion message with Telegram ID confirmation
                await ctx.reply(`✅ **Profile Setup Complete!**\n\n**Name:** ${session.data.fullName || 'Saved'}\n**Telegram ID:** ${userId} (Captured)\n**Phone:** ${session.data.phone || 'Saved'}\n**Country:** ${text}\n\nSelect your account type to proceed:`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '👤 Individual', callback_data: 'acct_INDIVIDUAL' }],
                            [{ text: '🏢 Law Firm', callback_data: 'acct_FIRM' }],
                            [{ text: '⚖️ Bar Association', callback_data: 'acct_BAR' }],
                            [{ text: '🤝 Join a Team', callback_data: 'acct_JOIN' }]
                        ]
                    }
                });
                session.step = 'SIGNUP_ACCOUNT_TYPE';
                return;

            case 'SIGNUP_REG_NUMBER':
                const userReg = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) } });
                const isFirmOrBar = userReg?.accountType === 'FIRM' || userReg?.accountType === 'BAR';
                // Strict Requirement: No skipping
                if (text.toLowerCase() === 'skip') {
                    return ctx.reply('❌ This field is required. Please enter your Registration Number.');
                }

                await prisma.user.update({
                    where: { telegramId: BigInt(userId) },
                    data: {
                        registrationNumber: text,
                        approvalStatus: isFirmOrBar ? 'PENDING' : 'APPROVED' // Firms need approval
                    } as any
                });

                session.step = 'IDLE';

                if (isFirmOrBar) {
                    await ctx.reply('✅ **Registration Submitted**\n\nYour account is now **PENDING APPROVAL**.\nOur administrators will review your registration details.\nYou will receive a notification here once approved.');
                    console.log(`[ADMIN ALERT] New Registration Pending: @${userReg?.username} (ID: ${userId}) - Type: ${userReg?.accountType}`);
                } else {
                    await ctx.reply('🎉 **Profile Complete!**\n\nYour account is set up but NOT VERIFIED.\n\nUse /verify to verify your account.\nUse /profile to view your info.\nUse /subscribe to upgrade your plan.');
                }
                return;

            case 'WAITING_VERIFY':
                const expectedCode = session.data.verificationCode;
                if (text === expectedCode) {
                    await prisma.user.update({
                        where: { telegramId: BigInt(userId) },
                        data: { isVerified: true }
                    });
                    session.step = 'IDLE';
                    session.data.verificationCode = undefined;
                    await ctx.reply('✅ **Account Verified!**\n\nYour account is now fully verified.\n\nYou can now access all features.\nUse /newbrief to start a case.');
                } else {
                    await ctx.reply('❌ **Invalid Code**\n\nThe code you entered is incorrect.\n\nPlease try again or use /verify to get a new code.');
                }
                return;

            case 'WAITING_JURISDICTION':
                session.data.jurisdiction = text;
                session.step = 'WAITING_COURT';
                ctx.reply('2. Which **Court** is this for? (e.g., Supreme Court, District Court)');
                return;

            case 'WAITING_COURT':
                session.data.court = text;
                session.step = 'WAITING_PARTIES';
                ctx.reply('3. Who are the **Parties**? (e.g., Smith v. Jones Corp)');
                return;

            case 'WAITING_PARTIES':
                session.data.parties = text;
                session.step = 'WAITING_FACTS';
                ctx.reply('4. Finally, please describe the **Facts** or upload a document now.');
                return;

            case 'WAITING_FACTS':
                session.data.facts = text;
                session.step = 'IDLE';
                // Trigger final processing
                await processCaseInput(ctx, { type: 'text', content: session.data.facts! }, session.data);
                return;
        }
    });

    bot.on(['document', 'photo'], async (ctx) => {
        const userId = ctx.from.id;
        const session = sessions[userId];

        // Check if we are in specific non-upload steps? No, allow global upload for now.
        // If uploading during intake (WAITING_FACTS), assume it's for that case.
        // If uploading in IDLE, ask New vs Existing.

        let fileId = '';
        let mime = 'unknown';

        if ('document' in ctx.message) {
            fileId = ctx.message.document.file_id;
            mime = ctx.message.document.mime_type || 'application/pdf';
        } else if ('photo' in ctx.message) {
            fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            mime = 'image/jpeg';
        }

        try {
            const fileLink = await ctx.telegram.getFileLink(fileId);

            // Initiate Session if needed
            if (!sessions[userId]) sessions[userId] = { step: 'IDLE', data: {} };
            const currentSession = sessions[userId];

            // AUTO OCR - Extract text from any image upload automatically
            if (mime.startsWith('image')) {
                await ctx.reply('🔄 **Extracting text from image...**\n\nThis may take a moment.');

                const extractedText = await extractTextFromDocument(fileLink.href, mime);

                if (extractedText.startsWith('Error')) {
                    await ctx.reply(`❌ ${extractedText}`);
                    currentSession.step = 'IDLE';
                    return;
                }

                // Store extracted text for editing
                currentSession.data.ocrText = extractedText;
                currentSession.step = 'IDLE';

                // Show preview with options
                const preview = extractedText.substring(0, 1500);
                await ctx.reply(`📝 **Extracted Text Preview:**\n\n\`\`\`\n${preview}${extractedText.length > 1500 ? '\n...(truncated)' : ''}\n\`\`\`\n\n**Total Characters:** ${extractedText.length}`, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ Use for New Case', callback_data: 'ocr_use_new' },
                                { text: '📋 Copy Text', callback_data: 'ocr_copy' }
                            ],
                            [
                                { text: '✏️ Edit Text', callback_data: 'ocr_edit' },
                                { text: '❌ Discard', callback_data: 'ocr_discard' }
                            ]
                        ]
                    }
                });
                return;
            }

            // STAGE THE FILE
            currentSession.staging = { type: 'file', content: fileLink.href, mime };

            // If already waiting for facts, auto-proceed
            if (currentSession.step === 'WAITING_FACTS') {
                await ctx.reply('📂 Document received for current brief. Analyzing...');
                currentSession.step = 'IDLE';
                await processCaseInput(ctx, currentSession.staging, currentSession.data);
                currentSession.staging = undefined;
                return;
            }

            // Otherwise, ask User
            await ctx.reply(`📂 **File Received** (${mime})\n\nIs this a New Case or for an Existing Matter?`, {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✨ New Case', callback_data: 'stage_new' },
                        { text: '📂 Add to Existing', callback_data: 'stage_existing' }
                    ], [
                        { text: '❌ Cancel', callback_data: 'stage_cancel' }
                    ]]
                }
            });

        } catch (e) {
            console.error('File Link Error:', e);
            ctx.reply('Error processing file. Please try again.');
        }
    });

    bot.action('stage_new', async (ctx) => {
        // Proceed to Analyze/Save choice (re-using previous staging logic flow)
        await ctx.answerCbQuery();
        await ctx.editMessageText(`📂 **New Case Setup**\n\nWhat would you like to do with this file?`, {
            reply_markup: {
                inline_keyboard: [[
                    { text: '🔍 Analyze & Brief', callback_data: 'stage_analyze' }, // existing handler
                    { text: '💾 Save Only', callback_data: 'stage_save' },       // existing handler
                    { text: '❌ Cancel', callback_data: 'stage_cancel' }
                ]]
            }
        });
    });

    // OCR ACTION HANDLERS
    bot.action('ocr_use_new', async (ctx) => {
        const userId = ctx.from.id;
        const session = sessions[userId];
        const ocrText = session?.data.ocrText;

        if (!ocrText) return ctx.answerCbQuery('OCR text expired. Please run /ocr again.');

        await ctx.answerCbQuery('Creating case from OCR text...');
        session.data.ocrText = undefined;

        // Process as new case
        await processCaseInput(ctx, { type: 'text', content: ocrText, mime: 'text/plain' }, {});
    });

    bot.action('ocr_copy', async (ctx) => {
        const userId = ctx.from.id;
        const session = sessions[userId];
        const ocrText = session?.data.ocrText;

        if (!ocrText) return ctx.answerCbQuery('OCR text expired.');

        await ctx.answerCbQuery();
        // Send as plain text for easy copying
        await ctx.reply(`📋 **Full Extracted Text:**\n\n${ocrText.substring(0, 4000)}`);
    });

    bot.action('ocr_edit', async (ctx) => {
        const userId = ctx.from.id;
        const session = sessions[userId];

        if (!session?.data.ocrText) return ctx.answerCbQuery('OCR text expired.');

        session.step = 'OCR_EDIT';
        await ctx.answerCbQuery();
        await ctx.reply('✏️ **Edit Mode**\n\nSend me the corrected text. You can copy the text above, edit it, and paste it back.\n\n_Type your corrected version and send it._');
    });

    bot.action('ocr_discard', async (ctx) => {
        const userId = ctx.from.id;
        if (sessions[userId]) sessions[userId].data.ocrText = undefined;
        await ctx.answerCbQuery('Discarded.');
        await ctx.editMessageText('❌ OCR text discarded.');
    });

    bot.action('stage_existing', async (ctx) => {
        const userId = ctx.from.id;
        const user = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) }, include: { cases: true } });

        if (!user || user.cases.length === 0) {
            return ctx.answerCbQuery('No existing cases found. Creationg new instead.');
            // Fallback to new
        }

        await ctx.answerCbQuery();

        // Show case list to associate
        ctx.editMessageText(`📂 **Select Case to Update:**`, {
            reply_markup: {
                inline_keyboard: user.cases.slice(-5).map(c => [
                    { text: `📥 Add to: ${c.refCode || c.id}`, callback_data: `stage_assoc_${c.id}` }
                ])
            }
        });
    });

    bot.action(/^stage_assoc_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        const userId = ctx.from.id;
        const session = sessions[userId];

        if (!session?.staging) return ctx.answerCbQuery('File expired.');

        await ctx.answerCbQuery('Associating...');

        // For MVP: We just "Analyze" it but set the title/context to the existing case?
        // Or append to description?
        // Let's just append to description for now to "Add" it.

        const existingCase = await prisma.caseMatter.findUnique({ where: { id: caseId } });
        await prisma.caseMatter.update({
            where: { id: caseId },
            data: {
                description: (existingCase?.description || '') + `\n\n[Added File]: ${session.staging.content}`
            }
        });

        await ctx.editMessageText(`✅ File added to **${existingCase?.refCode}**.\n\nRunning analysis context...`);

        // Run AI Q&A Loop on this new Context?
        session.data.facts = session.staging.content; // Temporarily focus on new file?
        // Or merge?
        // Let's just enter Q&A loop
        session.step = 'WAITING_QUESTION';
        session.staging = undefined;
        ctx.reply('❓ File analyzed. You can now ask questions about this specific document.');
    });

    // --- Staging Handlers ---
    bot.action('stage_analyze', async (ctx) => {
        const userId = ctx.from.id;
        const session = sessions[userId];
        if (!session?.staging) return ctx.answerCbQuery('Session expired.');

        await ctx.answerCbQuery();
        await ctx.editMessageText('🔍 Starting Analysis...');
        await processCaseInput(ctx, session.staging, session.data);
        session.staging = undefined;
    });

    bot.action('stage_save', async (ctx) => {
        const userId = ctx.from.id;
        const session = sessions[userId];
        if (!session?.staging) return ctx.answerCbQuery('Session expired.');

        await ctx.answerCbQuery('Saved.'); // Logic to just save user file "as is"
        // Simplified: use processCaseInput but with a flag? or just manual create?
        // For now, let's treat it as a "Quick Save" which skips AI but registers it.
        // Reusing processCaseInput but maybe we can mock the AI part for "Save Only" later
        // Or just simpler:

        const user = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) }, include: { cases: true } });
        const count = user?.cases.length || 0;
        const refCode = user?.firmCode ? `${user.firmCode}-${String(count + 1).padStart(3, '0')}` : `CASE-${count + 1}`;

        await prisma.caseMatter.create({
            data: {
                title: `Uploaded Document (Unprocessed)`,
                description: `File: ${session.staging.content}`,
                status: 'OPEN',
                userId: user?.id || 1,
                refCode: refCode
            }
        });

        await ctx.editMessageText(`💾 **Document Saved.**\nRef: ${refCode}`);
        session.staging = undefined;
        session.step = 'IDLE';
    });

    bot.action('stage_cancel', async (ctx) => {
        const userId = ctx.from.id;
        const session = sessions[userId];
        if (session) {
            session.staging = undefined;
            session.step = 'IDLE';
        }
        await ctx.answerCbQuery('Cancelled.');
        await ctx.editMessageText('❌ Upload Cancelled.');
    });



    // ADD LINK HANDLER
    bot.action(/^add_link_(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[1]);
        const userId = ctx.from.id;

        if (!sessions[userId]) sessions[userId] = { step: 'IDLE', data: {} };
        sessions[userId].step = 'WAITING_LINK';
        sessions[userId].data.currentCaseId = caseId;

        await ctx.answerCbQuery();
        await ctx.reply('🔗 **Add Custom Link**\n\nPlease paste the URL of the document or precedent you want to add to this case context.\n(Must be a direct link to PDF/Word/Image)');
    });

    // MEDIA HANDLERS (Voice, Audio, Photo)
    bot.on(['voice', 'audio'], async (ctx) => {
        const file = (ctx.message as any).voice || (ctx.message as any).audio;
        if (!file) return;

        const waitingMsg = await ctx.reply('🎙️ **Processing Audio...**\nTranscribing content...');
        try {
            const fileLink = await ctx.telegram.getFileLink(file.file_id);
            const text = await transcribeAudio(fileLink.href);

            await ctx.telegram.editMessageText(ctx.chat.id, waitingMsg.message_id, undefined,
                `🎙️ **Transcription Complete**\n\n"${text.substring(0, 500)}..."\n\nAnalyzing context...`);

            // Analyze the text
            const analysis = await aiService.analyzeLegalText(text);

            // Save to DB
            const userId = ctx.from.id;
            const user = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) }, include: { cases: true } });

            const count = user?.cases.length || 0;
            const refCode = user?.firmCode ? `${user.firmCode}-${String(count + 1).padStart(3, '0')}` : `CASE-${count + 1}`;

            const savedCase = await prisma.caseMatter.create({
                data: {
                    title: `Audio Note ${new Date().toLocaleDateString()}`,
                    description: text, // Store full subscript
                    status: 'OPEN',
                    userId: user?.id || 1,
                    refCode: refCode
                }
            });

            // Store in session
            if (!sessions[userId]) sessions[userId] = { step: 'IDLE', data: {} };
            sessions[userId].data.currentCaseId = savedCase.id;
            sessions[userId].data.facts = text;

            // Reply with analysis
            await ctx.reply(`✅ **Audio Analysis Ready**\nRef: ${refCode}\n\n**Prediction:** ${analysis.prediction}\n**Viability:** ${analysis.viabilityScore}%\n\n${analysis.keyIssues.map(i => `• ${i}`).join('\n')}`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💾 Save', callback_data: `saved_${savedCase.id}` }, { text: '❓ Ask Question', callback_data: `ask_${savedCase.id}` }]
                    ]
                }
            });

        } catch (error) {
            console.error('Audio processing failed:', error);
            await ctx.telegram.editMessageText(ctx.chat.id, waitingMsg.message_id, undefined, '❌ Transcription failed.');
        }
    });

    bot.on('photo', async (ctx) => {
        const photos = (ctx.message as any).photo;
        const file = photos[photos.length - 1]; // Get highest quality

        const waitingMsg = await ctx.reply('📷 **Processing Image...**\nExtracting text with OCR...');
        try {
            const fileLink = await ctx.telegram.getFileLink(file.file_id);
            const text = await extractTextFromDocument(fileLink.href, 'image/jpeg');

            await ctx.telegram.editMessageText(ctx.chat.id, waitingMsg.message_id, undefined,
                `📷 **OCR Complete**\n\n"${text.substring(0, 500)}..."\n\nAnalyzing...`);

            // Analyze the text
            const analysis = await aiService.analyzeLegalText(text);

            // Save to DB
            const userId = ctx.from.id;
            const user = await prisma.user.findUnique({ where: { telegramId: BigInt(userId) }, include: { cases: true } });

            const count = user?.cases.length || 0;
            const refCode = user?.firmCode ? `${user.firmCode}-${String(count + 1).padStart(3, '0')}` : `CASE-${count + 1}`;

            const savedCase = await prisma.caseMatter.create({
                data: {
                    title: `Image Capture ${new Date().toLocaleDateString()}`,
                    description: text,
                    status: 'OPEN',
                    userId: user?.id || 1,
                    refCode: refCode
                }
            });

            // Store in session
            if (!sessions[userId]) sessions[userId] = { step: 'IDLE', data: {} };
            sessions[userId].data.currentCaseId = savedCase.id;
            sessions[userId].data.facts = text;

            await ctx.reply(`✅ **Image Analysis Ready**\nRef: ${refCode}\n\n**Prediction:** ${analysis.prediction}\n**Viability:** ${analysis.viabilityScore}%\n\n${analysis.keyIssues.map(i => `• ${i}`).join('\n')}`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💾 Save', callback_data: `saved_${savedCase.id}` }, { text: '❓ Ask Question', callback_data: `ask_${savedCase.id}` }]
                    ]
                }
            });

        } catch (error) {
            console.error('OCR failed:', error);
            await ctx.telegram.editMessageText(ctx.chat.id, waitingMsg.message_id, undefined, '❌ Image analysis failed.');
        }
    });

    // EXPORT WIZARD HANDLERS
    bot.action(/^(export_case_|pre_export_)(\d+)/, async (ctx) => {
        const caseId = parseInt(ctx.match[2]);
        const userId = ctx.from.id;

        if (!sessions[userId]) sessions[userId] = { step: 'IDLE', data: {} };
        // Clean session data for export
        sessions[userId].data.currentCaseId = caseId;
        sessions[userId].data.exportSettings = {};

        await ctx.answerCbQuery();
        await ctx.reply('📤 **Export Customization**\n\nSelect File Format:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📄 PDF (Standard)', callback_data: `exp_fmt_PDF` }, { text: '📝 Word (Editable)', callback_data: `exp_fmt_Word` }]
                ]
            }
        });
    });

    bot.action(/^exp_fmt_(PDF|Word)/, async (ctx) => {
        const format = ctx.match[1];
        const userId = ctx.from.id;
        if (!sessions[userId]) return ctx.answerCbQuery('Session expired. Select case again.');

        sessions[userId].data.exportSettings = { format: format as any };
        sessions[userId].step = 'EXPORT_WORDS';

        await ctx.answerCbQuery();
        await ctx.reply('📝 **Word Count / Formatting**\n\nEnter the maximum word count (e.g. "1000") or type "Default" for standard full length analysis.');
    });

    return bot;
}
