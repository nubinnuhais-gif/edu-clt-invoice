// Reset (or create) a user's password when nobody can log in.
// Stop the server first, then run:  node reset-password.js <username> <new-password>
// Example:                          node reset-password.js admin MyNewPass1
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DB_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, "data"), "db.json");
const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.log("Usage: node reset-password.js <username> <new-password>");
  process.exit(1);
}
if (password.length < 6) {
  console.log("Password must be at least 6 characters.");
  process.exit(1);
}
if (!fs.existsSync(DB_FILE)) {
  console.log(`No database found at ${DB_FILE}. Start the server once first.`);
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.scryptSync(password, salt, 64).toString("hex");
let user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
if (user) Object.assign(user, { salt, hash });
else {
  user = { username, role: "admin", salt, hash, createdAt: new Date().toISOString() };
  db.users.push(user);
}
fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
console.log(`Password set for "${user.username}" (${user.role}). Start the server again and sign in.`);
