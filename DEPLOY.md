### 🟢 Free Tier "Fast-Track" (Best Combo)

For a 100% free production environment that doesn't delete your data:

1.  **Database: [Neon](https://neon.tech)**
    *   Create a free account.
    *   Create a project and copy the **Connection String**.
    *   It will look like `postgresql://alex:password@ep-cool-flower-123.us-east-2.aws.neon.tech/neondb?sslmode=require`.

2.  **Hosting: [Render](https://render.com)**

    *   Create a "Web Service" (Free Tier).
    *   Connect your GitHub.
    *   Add the `DATABASE_URL` from Neon.
    *   **Crucial**: Change `prisma/schema.prisma` provider to `postgresql` before pushing.

---


### Option 2: Render

1. Push code to GitHub
2. Go to [render.com](https://render.com)
3. Create "New Background Worker"
4. Connect your GitHub repo
5. Add environment variables
6. Deploy

---

## Environment Variables Required

| Variable | Description | Required |
|----------|-------------|----------|
| `BOT_TOKEN` | Telegram bot token from @BotFather | ✅ Yes |
| `OPENAI_API_KEY` | OpenAI API key | ✅ Yes |
| `DATABASE_URL` | PostgreSQL connection string | ✅ Yes (production) |
| `PAYSTACK_SECRET_KEY` | Paystack secret key | For payments |
| `NODE_ENV` | Set to `production` | Recommended |

---

## Database Migration (SQLite → PostgreSQL)

1. Update `prisma/schema.prisma`:
   ```prisma
   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }
   ```

2. Run migration:
   ```bash
   npx prisma migrate dev --name init
   ```

---

## Estimated Monthly Costs

| Users | Server | Database | OpenAI | Total |
|-------|--------|----------|--------|-------|
| 10 | $0 (free) | $0 (free) | ~$5 | ~$5 |
| 50 | $5 | $5 | ~$25 | ~$35 |
| 200 | $10 | $10 | ~$100 | ~$120 |

---


## 🛡️ User Approval Workflow
Firms and Bar Associations must be approved by an Admin before accessing the bot.
- **Admin Commands**:
  - `/pending`: List users waiting for approval.
  - `/approve <telegram_id>`: Approve a user.

## Post-Deployment Checklist

- [ ] Verify bot responds to /start
- [ ] Test document upload
- [ ] Verify admin commands work
- [ ] Set up database backups
- [ ] Monitor OpenAI usage dashboard

---

## 🔄 How to Update the Bot

Once the bot is deployed, follow these steps to add new features or apply updates:

### 1. Update Code
1. Make your changes locally and test them.
2. Commit and push to GitHub:
   ```bash
   git add .
   git commit -m "Add new feature: [description]"
   git push origin main
   ```
3. **Railway/Render** will detect the push and automatically start a new build.

### 2. Update Database (If schema changes)
If you modified `schema.prisma`:
1. The build script on Railway/Render should ideally include `npx prisma generate`.
2. To apply schema changes to your production database, run from your local machine (with the production `DATABASE_URL` in your `.env` temporarily):
   ```bash
   npx prisma db push
   ```
   *Note: For production, using `npx prisma migrate deploy` is safer than `db push`.*

### 3. Add New Environment Variables
If your new feature requires a new API key or setting:
1. Go to your Railway/Render dashboard.
2. Navigate to **Variables** or **Environment**.
3. Add the new Key/Value pair.
4. The bot will automatically restart to apply the new variables.

### 4. Monitor Logs
Always check the **Deployment Logs** on your hosting provider after an update to ensure the bot started correctly and there are no connection errors.

