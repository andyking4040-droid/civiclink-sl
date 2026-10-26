/**
 * CivicLINK – Sierra Leone
 * ASK&KNOW BEFORE YOU GO
 * ACOSAT Digital
 */

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Monime (Orange Money / AfriMoney / cards)
const MONIME_TOKEN = process.env.MONIME_TOKEN || "";
const MONIME_SPACE_ID = process.env.MONIME_SPACE_ID || "";
const MONIME_API = "https://api.monime.io/v1";

function daysForPlan(plan) {
  return plan === "annual" ? 365 : 30;
}

async function createMonimeCheckout({ name, amountValue, currency, successUrl, cancelUrl, reference, metadata }) {
  if (!MONIME_TOKEN || !MONIME_SPACE_ID) {
    // Test mode: no real payment
    return { testMode: true, redirectUrl: null };
  }
  const idem = "civiclink-" + reference + "-" + Date.now();
  const res = await fetch(`${MONIME_API}/checkout-sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MONIME_TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idem.slice(0, 64),
      "Monime-Space-Id": MONIME_SPACE_ID,
      "Monime-Version": "caph.2025-08-23",
    },
    body: JSON.stringify({
      name: name || "CivicLink Subscription",
      description: "ASK&KNOW BEFORE YOU GO – Access Pass",
      lineItems: [
        {
          name: "CivicLink Access Pass",
          price: { currency: currency || "SLE", value: amountValue },
          type: "custom",
          quantity: 1,
        },
      ],
      successUrl,
      cancelUrl,
      reference,
      paymentOptions: {
        momo: { disable: false, enabledProviders: ["m17", "m18"] },
        card: { disable: false },
        bank: { disable: false },
      },
      brandingOptions: { primaryColor: "#0033a0" },
      metadata: metadata || {},
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    const msg = (data.messages && data.messages[0]) || data.error || "Monime checkout failed";
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return {
    testMode: false,
    sessionId: data.result.id,
    redirectUrl: data.result.redirectUrl,
  };
}

const dbUrl = process.env.DATABASE_URL || "postgresql://localhost:5432/civiclink";
const useSsl = dbUrl && !dbUrl.includes("localhost") && !dbUrl.includes("127.0.0.1");

const pool = new Pool({
  connectionString: dbUrl,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "civiclink-ask-know-2026",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);
app.use(express.static(path.join(__dirname, "public")));
app.use("/qrcodes", express.static(path.join(__dirname, "uploads/qrcodes")));

const qrDir = path.join(__dirname, "uploads/qrcodes");
if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });

const logoPath = path.join(__dirname, "public", "logo.png");

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Please login first" });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

function makeSlug(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Generate QR with high error correction so a center logo can be placed */
async function generateQR(slug) {
  const url = `${BASE_URL}/l/${slug}`;
  const filePath = path.join(qrDir, `${slug}.png`);

  // Generate base QR (error correction H allows ~30% damage = room for logo)
  await QRCode.toFile(filePath, url, {
    width: 512,
    margin: 2,
    errorCorrectionLevel: "H",
    color: { dark: "#0a0a0a", light: "#ffffff" },
  });

  // Try to composite logo in center if sharp is available and logo exists
  try {
    if (fs.existsSync(logoPath)) {
      const sharp = require("sharp");
      const qrBuf = fs.readFileSync(filePath);
      const logoSize = 96; // ~19% of 512 — safe with H level
      const logoBuf = await sharp(logoPath)
        .resize(logoSize, logoSize, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .png()
        .toBuffer();

      // White circle/pad behind logo for scan reliability
      const pad = 8;
      const padSize = logoSize + pad * 2;
      const paddedLogo = await sharp({
        create: {
          width: padSize,
          height: padSize,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
      })
        .composite([{ input: logoBuf, gravity: "center" }])
        .png()
        .toBuffer();

      await sharp(qrBuf)
        .composite([{ input: paddedLogo, gravity: "center" }])
        .png()
        .toFile(filePath);
    }
  } catch (e) {
    // sharp not installed or failed — QR without logo still works
    console.log("QR logo composite skipped:", e.message);
  }

  return `/qrcodes/${slug}.png`;
}

// ---------- Auth ----------
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !password || (!email && !phone)) {
      return res.status(400).json({ error: "Name, password, and email or phone are required" });
    }
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, 'publisher') RETURNING id, name, email, phone, role`,
      [name, email || null, phone || null, hash]
    );
    const user = rows[0];
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.name = user.name;
    res.status(201).json({ success: true, user: { id: user.id, name: user.name, role: user.role } });
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "Email already registered" });
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, phone, password } = req.body;
    if (!password || (!email && !phone)) return res.status(400).json({ error: "Email/phone and password required" });
    const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1 OR phone = $2 LIMIT 1`, [email || null, phone || null]);
    if (!rows[0]) return res.status(401).json({ error: "Invalid credentials" });
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.name = user.name;
    res.json({ success: true, user: { id: user.id, name: user.name, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get("/api/me", async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  try {
    const { rows } = await pool.query(
      `SELECT id, name, role, email, country, plan, subscription_status, subscription_expires_at, qr_credits
       FROM users WHERE id = $1`,
      [req.session.userId]
    );
    const u = rows[0];
    if (!u) return res.json({ user: null });
    const active = u.subscription_status === "active" &&
      (!u.subscription_expires_at || new Date(u.subscription_expires_at) > new Date());
    res.json({
      user: {
        id: u.id,
        name: u.name,
        role: u.role,
        email: u.email,
        country: u.country,
        plan: u.plan,
        subscription_status: u.subscription_status,
        subscription_expires_at: u.subscription_expires_at,
        subscription_active: active,
        qr_credits: u.qr_credits,
      },
    });
  } catch (e) {
    res.json({ user: { id: req.session.userId, name: req.session.name, role: req.session.role } });
  }
});


// ---------- Subscribe (registration + Monime) ----------
app.post("/api/subscribe", async (req, res) => {
  try {
    const { name, email, phone, password, country, plan, amount_value, currency } = req.body;
    if (!name || !password || !email || !phone || !country || !plan) {
      return res.status(400).json({ error: "All fields are required" });
    }
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (!["monthly", "annual"].includes(plan)) return res.status(400).json({ error: "Invalid plan" });

    const hash = await bcrypt.hash(password, 10);
    let user;
    try {
      const { rows } = await pool.query(
        `INSERT INTO users (name, email, phone, password_hash, role, country, plan, subscription_status)
         VALUES ($1, $2, $3, $4, 'publisher', $5, $6, 'pending')
         RETURNING id, name, email, role`,
        [name, email, phone, hash, country, plan]
      );
      user = rows[0];
    } catch (err) {
      if (err.code === "23505") return res.status(400).json({ error: "Email already registered. Please login." });
      throw err;
    }

    const reference = "CL-" + user.id.slice(0, 8) + "-" + Date.now();
    const amountValue = parseInt(amount_value, 10) || 500;
    const curr = currency || "SLE";

    await pool.query(
      `INSERT INTO payments (user_id, plan, country, amount_value, currency, status, reference)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
      [user.id, plan, country, amountValue, curr, reference]
    );

    const successUrl = `${BASE_URL}/payment-success?ref=${encodeURIComponent(reference)}`;
    const cancelUrl = `${BASE_URL}/register?cancelled=1`;

    let checkout;
    try {
      checkout = await createMonimeCheckout({
        name: `CivicLink ${plan} – ${name}`,
        amountValue,
        currency: curr,
        successUrl,
        cancelUrl,
        reference,
        metadata: { userId: user.id, plan, country },
      });
    } catch (e) {
      console.error("Monime error:", e.message);
      return res.status(502).json({ error: "Payment gateway error: " + e.message });
    }

    if (checkout.testMode) {
      const days = daysForPlan(plan);
      await pool.query(
        `UPDATE users SET subscription_status = 'active',
           subscription_expires_at = NOW() + ($1 || ' days')::interval,
           qr_credits = 100
         WHERE id = $2`,
        [String(days), user.id]
      );
      await pool.query(
        `UPDATE payments SET status = 'completed', completed_at = NOW() WHERE reference = $1`,
        [reference]
      );
      req.session.userId = user.id;
      req.session.role = user.role;
      req.session.name = user.name;
      return res.json({ success: true, testMode: true, redirectUrl: "/publisher?activated=1" });
    }

    if (checkout.sessionId) {
      await pool.query(
        `UPDATE payments SET monime_session_id = $1 WHERE reference = $2`,
        [checkout.sessionId, reference]
      );
    }

    req.session.pendingUserId = user.id;
    req.session.pendingRef = reference;
    res.json({ success: true, redirectUrl: checkout.redirectUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed: " + (err.message || "unknown") });
  }
});

app.all("/api/payment-success", async (req, res) => {
  try {
    const ref = req.query.ref;
    if (!ref) return res.redirect("/register?error=missing_ref");
    const { rows } = await pool.query(`SELECT * FROM payments WHERE reference = $1`, [ref]);
    if (!rows[0]) return res.redirect("/register?error=payment_not_found");
    const payment = rows[0];
    if (payment.status !== "completed") {
      const days = daysForPlan(payment.plan);
      await pool.query(`UPDATE payments SET status = 'completed', completed_at = NOW() WHERE id = $1`, [payment.id]);
      await pool.query(
        `UPDATE users SET subscription_status = 'active',
           subscription_expires_at = NOW() + ($1 || ' days')::interval,
           plan = $2, qr_credits = GREATEST(COALESCE(qr_credits,0), 50)
         WHERE id = $3`,
        [String(days), payment.plan, payment.user_id]
      );
    }
    const { rows: users } = await pool.query(`SELECT id, name, role FROM users WHERE id = $1`, [payment.user_id]);
    if (users[0]) {
      req.session.userId = users[0].id;
      req.session.role = users[0].role;
      req.session.name = users[0].name;
    }
    res.redirect("/publisher?activated=1");
  } catch (err) {
    console.error(err);
    res.redirect("/register?error=activation_failed");
  }
});

app.post("/api/webhooks/monime", async (req, res) => {
  try {
    console.log("Monime webhook:", JSON.stringify(req.body || {}).slice(0, 500));
    res.json({ received: true });
  } catch (e) {
    res.status(500).json({ error: "webhook error" });
  }
});

// ---------- Locations ----------
app.post("/api/locations", requireAuth, async (req, res) => {
  try {
    // Subscription check
    const { rows: urows } = await pool.query(
      `SELECT subscription_status, subscription_expires_at, qr_credits, role FROM users WHERE id = $1`,
      [req.session.userId]
    );
    const u = urows[0];
    if (u && u.role !== "admin") {
      const active = u.subscription_status === "active" &&
        (!u.subscription_expires_at || new Date(u.subscription_expires_at) > new Date());
      if (!active) {
        return res.status(402).json({ error: "Active subscription required. Please renew your Access Pass." });
      }
    }

    const { name, type, address, phone, whatsapp, hours, services, description } = req.body;
    if (!name) return res.status(400).json({ error: "Location name is required" });
    const slug = makeSlug(name);
    const { rows } = await pool.query(
      `INSERT INTO locations (owner_id, name, type, address, phone, whatsapp, hours, services, description, slug)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.session.userId, name, type || "business", address || null, phone || null, whatsapp || phone || null, hours || null, services || null, description || null, slug]
    );
    const location = rows[0];
    const qrPath = await generateQR(slug);
    res.status(201).json({
      success: true,
      location: { ...location, qr_url: `${BASE_URL}/l/${slug}`, qr_image: qrPath },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create location" });
  }
});

app.get("/api/my-locations", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM locations WHERE owner_id = $1 ORDER BY created_at DESC`, [req.session.userId]);
    res.json({
      locations: rows.map((loc) => ({
        ...loc,
        qr_url: `${BASE_URL}/l/${loc.slug}`,
        qr_image: `/qrcodes/${loc.slug}.png`,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load locations" });
  }
});

app.get("/api/locations/:id", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM locations WHERE id = $1 AND owner_id = $2`, [req.params.id, req.session.userId]);
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json({ location: rows[0] });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.put("/api/locations/:id", requireAuth, async (req, res) => {
  try {
    const { name, type, address, phone, whatsapp, hours, services, description } = req.body;
    const { rows } = await pool.query(
      `UPDATE locations SET
         name = COALESCE($1, name), type = COALESCE($2, type), address = COALESCE($3, address),
         phone = COALESCE($4, phone), whatsapp = COALESCE($5, whatsapp), hours = COALESCE($6, hours), services = COALESCE($7, services),
         description = COALESCE($8, description), updated_at = NOW()
       WHERE id = $9 AND owner_id = $10 RETURNING *`,
      [name, type, address, phone, whatsapp, hours, services, description, req.params.id, req.session.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Location not found" });
    res.json({ success: true, location: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Update failed" });
  }
});

app.delete("/api/locations/:id", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM locations WHERE id = $1 AND owner_id = $2 RETURNING slug`,
      [req.params.id, req.session.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Location not found" });
    // Remove QR file
    const qrFile = path.join(qrDir, `${rows[0].slug}.png`);
    if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Delete failed" });
  }
});

// ---------- Public ----------
app.get("/api/location/:slug", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, type, address, phone, whatsapp, hours, services, description, is_verified, is_active, slug
       FROM locations WHERE slug = $1`,
      [req.params.slug]
    );
    if (!rows[0] || !rows[0].is_active) return res.status(404).json({ error: "Location not found or inactive" });
    res.json({ location: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load location" });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const type = (req.query.type || "").trim();
    if (q.length < 2 && !type) return res.json({ results: [] });

    let sql = `SELECT name, type, address, phone, slug, is_verified FROM locations WHERE is_active = TRUE`;
    const params = [];
    if (q.length >= 2) {
      params.push(`%${q}%`);
      sql += ` AND (name ILIKE $${params.length} OR type ILIKE $${params.length} OR address ILIKE $${params.length} OR services ILIKE $${params.length})`;
    }
    if (type) {
      params.push(type);
      sql += ` AND type = $${params.length}`;
    }
    sql += ` ORDER BY is_verified DESC, name LIMIT 40`;

    const { rows } = await pool.query(sql, params);
    res.json({ results: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed" });
  }
});

// ---------- Admin ----------
app.get("/api/admin/locations", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.*, u.name AS owner_name, u.email AS owner_email
       FROM locations l JOIN users u ON u.id = l.owner_id
       ORDER BY l.created_at DESC LIMIT 200`
    );
    res.json({ locations: rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to load" });
  }
});

app.post("/api/admin/locations/:id/verify", requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE locations SET is_verified = $1, updated_at = NOW() WHERE id = $2`, [!!req.body.verified, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/api/admin/locations/:id/toggle", requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE locations SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

// ---------- Pages ----------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/l/:slug", (req, res) => res.sendFile(path.join(__dirname, "public", "location.html")));
app.get("/publisher", (req, res) => res.sendFile(path.join(__dirname, "public", "publisher.html")));
app.get("/print-qr/:slug", (req, res) => res.sendFile(path.join(__dirname, "public", "print-qr.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/register", (req, res) => res.sendFile(path.join(__dirname, "public", "register.html")));
app.get("/terms.html", (req, res) => res.sendFile(path.join(__dirname, "public", "terms.html")));
app.all("/payment-success", async (req, res) => {
  // Monime may POST or GET with ref in query or body
  const ref =
    (req.query && req.query.ref) ||
    (req.body && (req.body.ref || req.body.reference || req.body.callbackState)) ||
    null;
  if (ref) {
    return res.redirect("/api/payment-success?ref=" + encodeURIComponent(String(ref)));
  }
  // Fallback: try to complete latest pending for session user
  if (req.session && req.session.pendingRef) {
    return res.redirect("/api/payment-success?ref=" + encodeURIComponent(req.session.pendingRef));
  }
  return res.redirect("/publisher?activated=1");
});

async function ensureAdmin() {
  try {
    const hash = await bcrypt.hash("civiclink2026", 10);
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ('ACOSAT Admin', 'admin@civiclink.sl', $1, 'admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = $1`,
      [hash]
    );
    console.log("Admin ready: admin@civiclink.sl / civiclink2026");
  } catch (e) {
    console.log("Admin seed skipped:", e.message);
  }
}

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`\nCivicLINK is running`);
  console.log(`ASK&KNOW BEFORE YOU GO`);
  console.log(`http://localhost:${PORT}`);
  console.log(`Publisher: http://localhost:${PORT}/publisher`);
  console.log(`Admin:     http://localhost:${PORT}/admin\n`);
  await ensureAdmin();
});
