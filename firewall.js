// --- Imports ---
const express = require("express");
const app = express();
const path = require("path");
const route = require("./routes/routes.routes");
const expressLayouts = require("express-ejs-layouts");
const session = require("express-session");
const ejs = require("ejs").__express;
const fs = require("fs");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const noble = require("@abandonware/noble");
const wifi = require("node-wifi");
const geoip = require("geoip-lite");
const chalk = require("chalk");

require("dotenv").config("config.env");
const port = process.env.PORT || 6000;

// --- Firewall Setup ---
const { firewall, limiter } = require("./firewall");

// --- Trust reverse proxy headers ---
app.set("trust proxy", 1);

// --- Middleware ---
app.use(cors());
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(limiter);

// --- Views and sessions ---
app.set("views", path.join(__dirname, "views/layouts"));
app.set("layout", "index");
app.set("view engine", "ejs");
app.engine("ejs", ejs);
app.use(expressLayouts);

app.use(session({
  resave: false,
  saveUninitialized: true,
  secret: "nodedemo",
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// --- Log inbound IP, City, Country ---
app.use((req, res, next) => {
  const ipRaw = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const ip = ipRaw.split(',')[0].replace('::ffff:', '').trim();
  const geo = geoip.lookup(ip) || {};
  const country = geo.country || "Unknown Country";
  const city = geo.city || "Unknown City";
  const now = new Date().toISOString();

  console.log(
    `${chalk.gray(`[${now}]`)} ${chalk.green('🌍 Access from')} ${chalk.cyan(city)}, ${chalk.magenta(country)} [${chalk.yellow(ip)}]`
  );

  next();
});

app.use(firewall);

// --- WordPress Scanner Firewall ---
app.use((req, res, next) => {
  const blockedPaths = [
    /^\/wp-/i, /^\/wordpress/i, /^\/xmlrpc\.php/i, /^\/blog\//i,
    /^\/site\//i, /^\/cms\//i, /^\/shop\//i, /^\/test\//i,
    /^\/news\//i, /^\/media\//i, /^\/wp1\//i, /^\/wp2\//i,
    /^\/website\//i, /^\/2018\//i, /^\/2019\//i
  ];
  if (blockedPaths.some(pattern => pattern.test(req.path))) {
    console.warn(`🛑 Blocked suspicious path: ${req.path}`);
    return res.status(403).send("Access Denied");
  }
  next();
});

// 🔐 Firewall Config API
const firewallConfigPath = path.join(__dirname, "firewall.config.json");

app.get("/api/firewall-config", (req, res) => {
  fs.readFile(firewallConfigPath, "utf8", (err, data) => {
    if (err) {
      console.error("❌ Error reading firewall.config.json:", err);
      return res.status(500).json({ error: "Could not load config." });
    }
    try {
      res.json(JSON.parse(data));
    } catch (parseError) {
      res.status(500).json({ error: "Invalid JSON format." });
    }
  });
});

app.post("/api/firewall-config", express.json(), (req, res) => {
  fs.writeFile(firewallConfigPath, JSON.stringify(req.body, null, 2), (err) => {
    if (err) {
      console.error("❌ Error writing firewall.config.json:", err);
      return res.status(500).json({ error: "Failed to save config." });
    }
    res.json({ success: true });
  });
});

// --- BLE & WiFi Scan Endpoints ---
wifi.init({ iface: null });
let bleDevices = [];
let scanning = false;

noble.on("discover", (peripheral) => {
  bleDevices.push({
    id: peripheral.id,
    name: peripheral.advertisement.localName || "Unnamed",
    rssi: peripheral.rssi
  });
});

app.get("/scanble", async (req, res) => {
  if (scanning) return res.status(429).json({ error: "Scan already in progress" });
  console.log("🚀 /scanble requested");
  bleDevices = [];
  scanning = true;

  try {
    noble.startScanning([], true, (err) => {
      if (err) {
        console.error("❌ noble.startScanning error:", err);
        scanning = false;
        if (!res.headersSent) return res.status(500).json({ error: "BLE scan start failed" });
      }

      setTimeout(() => {
        noble.stopScanning();
        scanning = false;
        if (!res.headersSent) res.json(bleDevices);
      }, 4000);
    });
  } catch (error) {
    scanning = false;
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || "Unexpected error in BLE scan" });
    }
  }
});

app.get("/scanwifi", async (req, res) => {
  console.log("📡 /scanwifi hit");
  try {
    const networks = await wifi.scan();
    res.json(networks.map(n => ({ ssid: n.ssid, signal: n.signal_level })));
  } catch (err) {
    console.error("❌ /scanwifi failed:", err.message);
    res.status(500).json({ error: err.message || "WiFi scan failed" });
  }
});

// --- Routes ---
app.use("/", route);

// --- Simple whoami test route ---
app.get("/whoami", (req, res) => {
  res.json({ status: "GreenDrive Server OK" });
});

// --- Start server ---
app.listen(port, () => console.log(`✅ Enterprise-grade backend running on port ${port}`));
