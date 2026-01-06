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

// INLINED DASHBOARD HTML (Avoids deployment file tracking issues)
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Super Admin Dashboard</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdn.datatables.net/1.13.4/css/dataTables.bootstrap5.min.css" rel="stylesheet">
    <style>
        body { background-color: #f8f9fa; padding: 20px; }
        .container { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .status-verified { color: green; font-weight: bold; }
        .status-unverified { color: orange; }
        .status-banned { color: red; font-weight: bold; }
    </style>
</head>
<body>

<div class="container">
    <h2 class="mb-4">👥 User Management</h2>
    <div id="loading" class="text-center">
        <div class="spinner-border text-primary" role="status"></div>
        <p>Loading users...</p>
    </div>

    <table id="usersTable" class="table table-striped table-hover" style="width:100%; display:none;">
        <thead>
            <tr>
                <th>ID</th>
                <th>Name / Username</th>
                <th>Phone</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Actions</th>
            </tr>
        </thead>
        <tbody></tbody>
    </table>
</div>

<!-- Edit User Modal -->
<div class="modal fade" id="editModal" tabindex="-1">
    <div class="modal-dialog">
        <div class="modal-content">
            <div class="modal-header">
                <h5 class="modal-title">Edit User</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <input type="hidden" id="editId">
                <div class="mb-3">
                    <label>Plan Type</label>
                    <select id="editPlan" class="form-select">
                        <option value="FREE">FREE</option>
                        <option value="PRO">PRO</option>
                        <option value="FIRM">FIRM</option>
                        <option value="BAR">BAR ASSOCIATION</option>
                    </select>
                </div>
                <div class="mb-3">
                    <label>Subscription Expiry</label>
                    <input type="date" id="editExpiry" class="form-control">
                </div>
                <div class="mb-3 form-check">
                    <input type="checkbox" class="form-check-input" id="editVerify">
                    <label class="form-check-label">Verified</label>
                </div>
                <div class="mb-3 form-check">
                    <input type="checkbox" class="form-check-input" id="editBan">
                    <label class="form-check-label text-danger">Banned</label>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
                <button type="button" class="btn btn-primary" onclick="saveUser()">Save Changes</button>
            </div>
        </div>
    </div>
</div>

<script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script src="https://cdn.datatables.net/1.13.4/js/jquery.dataTables.min.js"></script>
<script src="https://cdn.datatables.net/1.13.4/js/dataTables.bootstrap5.min.js"></script>

<script>
    const tg = window.Telegram.WebApp;
    tg.expand();

    // Get Auth Token from URL (passed by bot)
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');

    let table;

    $(document).ready(function() {
        if (!token) {
            alert('Unauthorized: No token provided');
            return;
        }
        loadUsers();
    });

    function loadUsers() {
        $.ajax({
            url: \`/api/admin/users?token=\${token}\`,
            method: 'GET',
            success: function(users) {
                $('#loading').hide();
                $('#usersTable').show();
                
                const data = users.map(u => [
                    u.telegramId,
                    \`<b>\${u.fullName || 'N/A'}</b><br>@\${u.username || ''}\`,
                    u.phone || 'N/A',
                    \`<span class="badge bg-info text-dark">\${u.subscription}</span>\`,
                    \`
                        \${u.isVerified ? '<span class="status-verified">Verified</span>' : '<span class="status-unverified">Unverified</span>'}
                        \${u.isBanned ? '<br><span class="status-banned">BANNED</span>' : ''}
                    \`,
                    \`<button class="btn btn-sm btn-primary" onclick="openEdit(\${u.telegramId})">Edit</button>
                     <button class="btn btn-sm btn-danger" onclick="deleteUser(\${u.telegramId})">Delete</button>\`
                ]);

                if (table) table.destroy();
                table = $('#usersTable').DataTable({
                    data: data,
                    responsive: true
                });
            },
            error: function(err) {
                alert('Failed to load users: ' + (err.responseJSON?.error || err.statusText));
            }
        });
    }

    function openEdit(id) {
        // Fetch specific user details
        $.ajax({
            url: \`/api/admin/users/\${id}?token=\${token}\`,
            method: 'GET',
            success: function(user) {
                $('#editId').val(user.telegramId);
                $('#editPlan').val(user.subscription);
                $('#editVerify').prop('checked', user.isVerified);
                $('#editBan').prop('checked', user.isBanned);
                
                if (user.subscriptionExp) {
                    $('#editExpiry').val(user.subscriptionExp.split('T')[0]);
                } else {
                    $('#editExpiry').val('');
                }
                
                new bootstrap.Modal('#editModal').show();
            }
        });
    }

    function saveUser() {
        const id = $('#editId').val();
        const data = {
            subscription: $('#editPlan').val(),
            subscriptionExp: $('#editExpiry').val(),
            isVerified: $('#editVerify').is(':checked'),
            isBanned: $('#editBan').is(':checked')
        };

        $.ajax({
            url: \`/api/admin/users/\${id}?token=\${token}\`,
            method: 'PUT',
            contentType: 'application/json',
            data: JSON.stringify(data),
            success: function() {
                bootstrap.Modal.getInstance('#editModal').hide();
                loadUsers(); // Refresh
                tg.showAlert('User updated successfully!');
            },
            error: function(err) {
                alert('Update failed');
            }
        });
    }

    function deleteUser(id) {
        if (confirm('Are you sure you want to DELETE this user? This cannot be undone.')) {
            $.ajax({
                url: \`/api/admin/users/\${id}?token=\${token}\`,
                method: 'DELETE',
                success: function() {
                    loadUsers();
                    tg.showAlert('User deleted.');
                }
            });
        }
    }
</script>

</body>
</html>
`;

// Middleware
app.use(cors());
app.use(bodyParser.json());
// app.use(express.static(path.join(__dirname, '../public'))); // Disabled due to build issues

// SERVE DASHBOARD
app.get('/admin.html', (req, res) => res.send(DASHBOARD_HTML));

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

