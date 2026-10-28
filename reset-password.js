// Reset (or create) a user's password when nobody can log in.
// Usage:  DATABASE_URL=postgres://... node reset-password.js <username> <new-password>
// Example: DATABASE_URL=postgres://clt:secret@127.0.0.1/clt_invoice node reset-password.js admin MyNewPass1
const crypto = require("crypto");
const { createStore } = require("./store");

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.log("Usage: node reset-password.js <username> <new-password>  (set DATABASE_URL first)");
  process.exit(1);
}
if (password.length < 6) {
  console.log("Password must be at least 6 characters.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.log("Set DATABASE_URL first.");
  process.exit(1);
}

(async () => {
  const store = createStore(process.env.DATABASE_URL);
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  const found = await store.query("SELECT data FROM users WHERE lower(username) = lower($1)", [username]);
  let user;
  if (found.rowCount) user = { ...found.rows[0].data, salt, hash };
  else user = { username, role: "admin", salt, hash, createdAt: new Date().toISOString() };
  await store.query(
    "INSERT INTO users (username, data) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET data = EXCLUDED.data",
    [user.username, JSON.stringify(user)]);
  console.log(`Password set for "${user.username}" (${user.role}). Restart the server and sign in.`);
  await store.close();
})().catch(e => { console.error(e.message); process.exit(1); });
