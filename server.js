require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const https = require("https");
const ExcelJS = require("exceljs");
const fs = require("fs");

const app = express();

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 5000;
const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SECRET_KEY || "";
const PAYMONGO_SUCCESS_URL =
  process.env.PAYMONGO_SUCCESS_URL || `${FRONTEND_ORIGIN}/payment/success`;
const PAYMONGO_CANCEL_URL =
  process.env.PAYMONGO_CANCEL_URL || `${FRONTEND_ORIGIN}/payment/cancel`;

const ROOM_PRICES = {
  "Single Bed": 500,
  "Double Bed": 2000,
  "Family Size Bed": 4000,
};

app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
  }),
);

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  ssl: {
    ca: fs.readFileSync("./ca (3).pem"),
    rejectUnauthorized: true,
  },
  enableKeepAlive: true,
  keepAliveInitialDelayMs: 0,
});

(async () => {
  try {
    const conn = await pool.getConnection();
    await conn.ping();

    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        contact VARCHAR(100),
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('admin','user') NOT NULL DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS archived_users (
        id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        contact VARCHAR(100),
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('admin','user') NOT NULL DEFAULT 'user',
        created_at TIMESTAMP,
        archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, archived_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS room_reservations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        user_name VARCHAR(255) NOT NULL,
        room_type VARCHAR(255) NOT NULL,
        guests INT NOT NULL,
        reservation_date DATE NOT NULL,
        reservation_time TIME NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        phone_number VARCHAR(50),
        special_requests TEXT,
        payment_status ENUM('pending','paid') DEFAULT 'pending',
        feedback_rating INT CHECK(feedback_rating >= 1 AND feedback_rating <= 5),
        feedback_comment TEXT,
        feedback_date TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS table_reservations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        user_name VARCHAR(255),
        restaurant_name VARCHAR(255) NOT NULL,
        guests INT NOT NULL,
        reservation_date DATE NOT NULL,
        reservation_time TIME NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        phone_number VARCHAR(50),
        special_requests TEXT,
        agree_policy TINYINT(1) DEFAULT 0,
        selected_menu JSON,
        menu_total DECIMAL(10,2) DEFAULT 0,
        payment_status ENUM('pending','paid') DEFAULT 'pending',
        feedback_rating INT CHECK(feedback_rating >= 1 AND feedback_rating <= 5),
        feedback_comment TEXT,
        feedback_date TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        reservation_id INT NOT NULL,
        reservation_type ENUM('room','table','menu') NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        provider VARCHAR(50) NOT NULL DEFAULT 'paymongo',
        status ENUM('pending','paid','failed') NOT NULL DEFAULT 'pending',
        checkout_id VARCHAR(255) NOT NULL UNIQUE,
        checkout_url TEXT,
        provider_response JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS menu_selections (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        selected_menu JSON NOT NULL,
        total_amount DECIMAL(10,2) NOT NULL,
        status ENUM('pending','confirm','paid') NOT NULL DEFAULT 'pending',
        feedback_rating INT CHECK(feedback_rating >= 1 AND feedback_rating <= 5),
        feedback_comment TEXT,
        feedback_date TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS menu_payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        menu_selection_id INT NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        provider VARCHAR(50) NOT NULL DEFAULT 'paymongo',
        status ENUM('pending','paid','failed') NOT NULL DEFAULT 'pending',
        checkout_id VARCHAR(255) NOT NULL UNIQUE,
        checkout_url TEXT,
        provider_response JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (menu_selection_id) REFERENCES menu_selections(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    console.log("Database connected and tables ensured!");
    conn.release();
  } catch (err) {
    console.error("Database connection failed:", err.message);
  }
})();

function getRoomPrice(roomType) {
  if (!roomType) return null;
  return ROOM_PRICES[roomType] ?? null;
}

function requestPaymongo(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: "api.paymongo.com",
      path: "/v1/checkout_sessions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${PAYMONGO_SECRET_KEY}:`).toString(
          "base64",
        )}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let responseData = "";
      res.on("data", (chunk) => {
        responseData += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(responseData || "{}");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const detail =
              parsed?.errors?.[0]?.detail ||
              parsed?.errors?.[0]?.message ||
              "PayMongo request failed";
            const err = new Error(detail);
            err.status = res.statusCode;
            err.response = parsed;
            reject(err);
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function fetchPaymongoCheckoutSession(sessionId) {
  return new Promise((resolve, reject) => {
    if (!sessionId) {
      reject(new Error("Missing checkout session id."));
      return;
    }
    const options = {
      hostname: "api.paymongo.com",
      path: `/v1/checkout_sessions/${sessionId}`,
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${PAYMONGO_SECRET_KEY}:`).toString(
          "base64",
        )}`,
      },
    };

    const req = https.request(options, (res) => {
      let responseData = "";
      res.on("data", (chunk) => {
        responseData += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(responseData || "{}");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const detail =
              parsed?.errors?.[0]?.detail ||
              parsed?.errors?.[0]?.message ||
              "Unable to fetch PayMongo session.";
            const err = new Error(detail);
            err.status = res.statusCode;
            err.response = parsed;
            reject(err);
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

async function createPaymongoCheckoutSession({ lineItem, metadata }) {
  if (!PAYMONGO_SECRET_KEY) {
    throw new Error("PayMongo secret key is not configured.");
  }

  const payload = {
    data: {
      attributes: {
        send_email_receipt: true,
        show_line_items_subtotal_label: true,
        line_items: [
          {
            currency: "PHP",
            amount: lineItem.amount,
            description: lineItem.description,
            name: lineItem.name,
            quantity: 1,
          },
        ],
        payment_method_types: ["gcash", "card", "paymaya"],
        success_url: PAYMONGO_SUCCESS_URL,
        cancel_url: PAYMONGO_CANCEL_URL,
        metadata,
      },
    },
  };

  return requestPaymongo(payload);
}

function setAuthCookie(res, payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

async function authMiddleware(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ message: "Unauthenticated" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ message: "Forbidden: Admins only." });
  }
  next();
}

app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, contact, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: "Missing fields" });
    }

    const conn = await pool.getConnection();
    try {
      const [exists] = await conn.query(
        "SELECT id FROM users WHERE email = ?",
        [email],
      );
      if (exists.length)
        return res.status(409).json({ message: "Email already exists" });

      const [admins] = await conn.query(
        "SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin'",
      );
      const role = admins[0].cnt === 0 ? "admin" : "user";

      const password_hash = await bcrypt.hash(password, 10);
      const [result] = await conn.query(
        "INSERT INTO users (name, email, contact, password_hash, role) VALUES (?,?,?,?,?)",
        [name, email, contact || null, password_hash, role],
      );

      const user = { id: result.insertId, name, email, role };
      setAuthCookie(res, user);
      return res.status(201).json({ user, firstAdmin: role === "admin" });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT id, name, email, password_hash, role FROM users WHERE email = ? LIMIT 1",
        [email],
      );
      if (!rows.length)
        return res.status(401).json({ message: "Invalid credentials" });

      const u = rows[0];
      const ok = await bcrypt.compare(password, u.password_hash);
      if (!ok) return res.status(401).json({ message: "Invalid credentials" });

      const user = { id: u.id, name: u.name, email: u.email, role: u.role };
      setAuthCookie(res, user);
      return res.json({ user });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

app.get("/api/auth/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  res.json({ ok: true });
});

app.post("/api/menu-selections", authMiddleware, async (req, res) => {
  const { selectedMenu, totalAmount } = req.body;
  const userId = req.user.id;

  if (
    !selectedMenu ||
    !Array.isArray(selectedMenu) ||
    selectedMenu.length === 0
  ) {
    return res.status(400).json({ message: "Selected menu is required" });
  }

  if (!totalAmount || totalAmount <= 0) {
    return res
      .status(400)
      .json({ message: "Total amount must be greater than 0" });
  }

  try {
    const conn = await pool.getConnection();
    try {
      await conn.query(
        "INSERT INTO menu_selections (user_id, selected_menu, total_amount) VALUES (?, ?, ?)",
        [userId, JSON.stringify(selectedMenu), totalAmount],
      );

      res.status(201).json({
        message: "Menu selections saved successfully",
        id: (await conn.query("SELECT LAST_INSERT_ID() as id"))[0][0].id,
      });
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("Error saving menu selections:", error);
    return res.status(500).json({ message: "Unable to save menu selections" });
  }
});

app.get("/api/menu-selections", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        "SELECT id, selected_menu, total_amount, status, feedback_rating, feedback_comment, feedback_date, created_at FROM menu_selections WHERE user_id = ? ORDER BY created_at DESC",
        [userId],
      );

      const parsedRows = rows.map((row) => ({
        ...row,
        selected_menu:
          typeof row.selected_menu === "string"
            ? JSON.parse(row.selected_menu)
            : row.selected_menu,
      }));

      res.json(parsedRows);
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("Error fetching menu selections:", error);
    return res.status(500).json({ message: "Unable to fetch menu selections" });
  }
});

app.get("/api/room-reservations/dates", async (req, res) => {
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        `SELECT DISTINCT reservation_date FROM room_reservations ORDER BY reservation_date ASC`,
      );
      const dates = rows
        .map((row) => row.reservation_date)
        .filter(Boolean)
        .map((date) => new Date(date).toISOString().split("T")[0]);
      return res.json({ dates });
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "Unable to fetch reserved dates",
    });
  }
});

app.get("/api/room-reservations", authMiddleware, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    try {
      const [paymentRows] = await conn.query(
        `SELECT reservation_id, reservation_type, amount, status, checkout_id, checkout_url, created_at
         FROM payments
         WHERE user_id = ?
         ORDER BY created_at DESC`,
        [req.user.id],
      );

      const paymentMap = new Map();
      for (const payment of paymentRows) {
        const key = `${payment.reservation_type}-${payment.reservation_id}`;
        if (!paymentMap.has(key)) {
          paymentMap.set(key, {
            ...payment,
            amount: Number(payment.amount || 0),
            created_at: payment.created_at
              ? new Date(payment.created_at).toISOString()
              : null,
          });
        }
      }

      const [rows] = await conn.query(
        `SELECT id, user_id, user_name, room_type, guests, reservation_date, reservation_time, full_name, email, phone_number, special_requests, payment_status, feedback_rating, feedback_comment, feedback_date, created_at
         FROM room_reservations
         WHERE user_id = ?
         ORDER BY reservation_date DESC, reservation_time DESC, id DESC`,
        [req.user.id],
      );

      const reservations = rows.map((row) => ({
        ...row,
        reservation_date: row.reservation_date
          ? new Date(row.reservation_date).toISOString().split("T")[0]
          : null,
        payment: paymentMap.get(`room-${row.id}`) || null,
      }));

      return res.json({ reservations });
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Unable to fetch room reservations" });
  }
});

app.post("/api/room-reservations", authMiddleware, async (req, res) => {
  const {
    roomType,
    guests,
    date,
    time,
    fullName,
    email,
    phoneNumber,
    specialRequests,
  } = req.body;

  if (!roomType || !guests || !date || !time || !fullName) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query(
        `INSERT INTO room_reservations
          (user_id, user_name, room_type, guests, reservation_date, reservation_time, full_name, email, phone_number, special_requests)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

        [
          req.user.id,
          req.user.name,
          roomType,
          guests,
          date,
          time,
          fullName,
          email || null,
          phoneNumber || null,
          specialRequests || null,
        ],
      );

      return res.status(201).json({
        reservationId: result.insertId,
        roomType,
        guests,
        date,
        time,
      });
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Unable to save reservation" });
  }
});

app.get("/api/table-reservations", authMiddleware, async (req, res) => {
  try {
    const conn = await pool.getConnection();
    try {
      const [paymentRows] = await conn.query(
        `SELECT reservation_id, reservation_type, amount, status, checkout_id, checkout_url, created_at
         FROM payments
         WHERE user_id = ?
         ORDER BY created_at DESC`,
        [req.user.id],
      );

      const paymentMap = new Map();
      for (const payment of paymentRows) {
        const key = `${payment.reservation_type}-${payment.reservation_id}`;
        if (!paymentMap.has(key)) {
          paymentMap.set(key, {
            ...payment,
            amount: Number(payment.amount || 0),
            created_at: payment.created_at
              ? new Date(payment.created_at).toISOString()
              : null,
          });
        }
      }

      const [rows] = await conn.query(
        `SELECT id, user_id, user_name, restaurant_name, guests, reservation_date, reservation_time, full_name, email, phone_number, special_requests, agree_policy, selected_menu, menu_total, payment_status, feedback_rating, feedback_comment, feedback_date, created_at
         FROM table_reservations
         WHERE user_id = ?
         ORDER BY reservation_date DESC, reservation_time DESC, id DESC`,
        [req.user.id],
      );

      const reservations = rows.map((row) => {
        let selectedMenu = [];
        if (row.selected_menu) {
          if (Array.isArray(row.selected_menu)) {
            selectedMenu = row.selected_menu;
          } else {
            try {
              selectedMenu = JSON.parse(row.selected_menu);
            } catch {
              selectedMenu = [];
            }
          }
        }
        return {
          ...row,
          reservation_date: row.reservation_date
            ? new Date(row.reservation_date).toISOString().split("T")[0]
            : null,
          selected_menu: selectedMenu,
          payment: paymentMap.get(`table-${row.id}`) || null,
        };
      });

      return res.json({ reservations });
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Unable to fetch table reservations" });
  }
});

app.post("/api/table-reservations", authMiddleware, async (req, res) => {
  const {
    restaurantName,
    guests,
    date,
    time,
    fullName,
    email,
    phoneNumber,
    specialRequests,
    agreePolicy,
    selectedMenu,
    menuTotal,
    userId,
    userName,
  } = req.body;

  if (!restaurantName || !guests || !date || !time || !fullName) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  const normalizedMenu = Array.isArray(selectedMenu)
    ? selectedMenu
        .map((item) => ({
          name: item.name,
          quantity: Number(item.quantity) || 0,
          price: Number(item.price) || 0,
          total: Number(item.total) || 0,
        }))
        .filter((item) => item.quantity > 0)
    : [];
  const normalizedTotal =
    typeof menuTotal === "number" ? menuTotal : Number(menuTotal) || 0;

  const ownerId = req.user?.id || userId || null;
  const ownerName = req.user?.name || userName || null;

  try {
    const conn = await pool.getConnection();
    try {
      const [result] = await conn.query(
        `INSERT INTO table_reservations
          (user_id, user_name, restaurant_name, guests, reservation_date, reservation_time, full_name, email, phone_number, special_requests, agree_policy, selected_menu, menu_total)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

        [
          ownerId,
          ownerName,
          restaurantName,
          Number(guests),
          date,
          time,
          fullName,
          email || null,
          phoneNumber || null,
          specialRequests || null,
          agreePolicy ? 1 : 0,
          JSON.stringify(normalizedMenu),
          normalizedTotal,
        ],
      );

      return res.status(201).json({
        reservationId: result.insertId,
        guests: Number(guests),
        date,
        time,
        restaurantName,
        menuTotal: normalizedTotal,
      });
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Unable to save table reservation" });
  }
});

app.post("/api/payments/paymongo", authMiddleware, async (req, res) => {
  const reservationId = Number(req.body?.reservationId);
  const reservationType = String(req.body?.reservationType || "").toLowerCase();

  if (!reservationId || !reservationType) {
    return res
      .status(400)
      .json({ message: "Reservation id and type are required." });
  }

  try {
    const conn = await pool.getConnection();
    try {
      let amount = null;
      let name = "";
      let description = "";

      if (reservationType === "room") {
        const [rows] = await conn.query(
          `SELECT id, room_type, reservation_date, reservation_time, guests, user_id
           FROM room_reservations
           WHERE id = ? AND user_id = ?`,
          [reservationId, req.user.id],
        );
        if (!rows.length) {
          return res
            .status(404)
            .json({ message: "Room reservation not found." });
        }
        const roomReservation = rows[0];
        const roomPrice = getRoomPrice(roomReservation.room_type);
        if (!roomPrice) {
          return res
            .status(400)
            .json({ message: "Price not configured for this reservation." });
        }
        amount = roomPrice;
        name = `${roomReservation.room_type} Reservation`;
        const dateStr = roomReservation.reservation_date
          ? new Date(roomReservation.reservation_date)
              .toISOString()
              .split("T")[0]
          : "TBD";
        const timeStr = roomReservation.reservation_time
          ? roomReservation.reservation_time.toString().slice(0, 5)
          : "TBD";
        description = `Room reservation on ${dateStr} at ${timeStr} for ${
          roomReservation.guests || 0
        } guest(s).`;
      } else if (reservationType === "table") {
        const [rows] = await conn.query(
          `SELECT id, restaurant_name, reservation_date, reservation_time, menu_total, user_id
           FROM table_reservations
           WHERE id = ? AND user_id = ?`,
          [reservationId, req.user.id],
        );
        if (!rows.length) {
          return res
            .status(404)
            .json({ message: "Table reservation not found." });
        }
        const tableReservation = rows[0];
        const total = Number(tableReservation.menu_total || 0);
        if (total <= 0) {
          return res.status(400).json({
            message: "Table reservation does not have a payable amount.",
          });
        }
        amount = total;
        name = `${tableReservation.restaurant_name} Table Reservation`;
        const dateStr = tableReservation.reservation_date
          ? new Date(tableReservation.reservation_date)
              .toISOString()
              .split("T")[0]
          : "TBD";
        const timeStr = tableReservation.reservation_time
          ? tableReservation.reservation_time.toString().slice(0, 5)
          : "TBD";
        description = `Table reservation on ${dateStr} at ${timeStr}.`;
      } else {
        return res.status(400).json({ message: "Invalid reservation type." });
      }

      const checkoutResponse = await createPaymongoCheckoutSession({
        lineItem: {
          name,
          description,
          amount: Math.round(Number(amount) * 100),
        },
        metadata: {
          reservationId,
          reservationType,
          userId: req.user.id,
        },
      });

      const checkoutUrl =
        checkoutResponse?.data?.attributes?.checkout_url || null;
      const checkoutId = checkoutResponse?.data?.id || null;

      if (!checkoutUrl || !checkoutId) {
        throw new Error("Unable to create PayMongo checkout session.");
      }

      await conn.query(
        `INSERT INTO payments (user_id, reservation_id, reservation_type, amount, checkout_id, checkout_url)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           amount = VALUES(amount),
           checkout_url = VALUES(checkout_url),
           updated_at = CURRENT_TIMESTAMP`,
        [
          req.user.id,
          reservationId,
          reservationType,
          Number(amount),
          checkoutId,
          checkoutUrl,
        ],
      );

      return res.json({ checkoutUrl, checkoutId });
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("PayMongo checkout failure:", error);
    const status = error.status || 500;
    return res
      .status(status)
      .json({ message: error.message || "Unable to start payment." });
  }
});

app.post("/api/payments/menu", authMiddleware, async (req, res) => {
  const menuSelectionId = Number(req.body?.menuSelectionId);
  const userId = req.user.id;

  if (!menuSelectionId) {
    return res.status(400).json({ message: "Menu selection id is required." });
  }

  try {
    const conn = await pool.getConnection();
    try {
      const [menuRows] = await conn.query(
        "SELECT id, selected_menu, total_amount FROM menu_selections WHERE id = ? AND user_id = ?",
        [menuSelectionId, userId],
      );

      if (!menuRows.length) {
        return res.status(404).json({ message: "Menu selection not found." });
      }

      const menuSelection = menuRows[0];
      const totalAmountCents = Math.round(menuSelection.total_amount * 100);
      const selectedMenu =
        typeof menuSelection.selected_menu === "string"
          ? JSON.parse(menuSelection.selected_menu)
          : menuSelection.selected_menu;

      const checkoutResponse = await createPaymongoCheckoutSession({
        lineItem: {
          name: "Menu Order",
          description: `Menu order #${menuSelectionId}`,
          amount: totalAmountCents,
        },
        metadata: {
          menu_selection_id: menuSelectionId,
          user_id: userId,
          type: "menu",
        },
      });

      const checkoutUrl =
        checkoutResponse?.data?.attributes?.checkout_url || null;
      const checkoutId = checkoutResponse?.data?.id || null;

      if (!checkoutUrl || !checkoutId) {
        throw new Error("Unable to create PayMongo checkout session.");
      }

      await conn.query(
        `INSERT INTO menu_payments (user_id, menu_selection_id, amount, checkout_id, checkout_url)
         VALUES (?, ?, ?, ?, ?)`,
        [
          userId,
          menuSelectionId,
          menuSelection.total_amount,
          checkoutId,
          checkoutUrl,
        ],
      );

      return res.json({
        checkoutId,
        checkoutUrl,
        message: "Checkout session created successfully",
      });
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("Menu payment checkout failure:", error);
    const status = error.status || 500;
    return res
      .status(status)
      .json({ message: error.message || "Unable to start menu payment." });
  }
});

app.get("/api/payments/menu", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    const conn = await pool.getConnection();
    try {
      const [payments] = await conn.query(
        "SELECT id, user_id, menu_selection_id, amount, status, checkout_id, checkout_url, created_at FROM menu_payments WHERE user_id = ? ORDER BY created_at DESC",
        [userId],
      );

      res.json(payments || []);
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("Error fetching menu payments:", error);
    return res.status(500).json({ message: "Unable to fetch menu payments" });
  }
});

app.post("/api/payments/paymongo/confirm", authMiddleware, async (req, res) => {
  const checkoutSessionId = req.body?.checkoutSessionId;

  if (!checkoutSessionId) {
    return res
      .status(400)
      .json({ message: "Checkout session identifier is required." });
  }

  try {
    const conn = await pool.getConnection();
    try {
      console.log(
        "Looking for payment with checkout_id:",
        checkoutSessionId,
        "user_id:",
        req.user.id,
      );
      const [paymentRows] = await conn.query(
        `SELECT id, reservation_id, reservation_type
         FROM payments
         WHERE checkout_id = ? AND user_id = ?
         LIMIT 1`,
        [checkoutSessionId, req.user.id],
      );

      console.log("Query result paymentRows:", paymentRows);

      if (!paymentRows.length) {
        return res.status(404).json({
          message: "Payment record not found for this session.",
        });
      }

      const payment = paymentRows[0];
      console.log("Found payment record:", {
        id: payment.id,
        reservation_id: payment.reservation_id,
        reservation_type: payment.reservation_type,
        type_length: payment.reservation_type?.length,
      });

      await conn.query(
        `UPDATE payments
         SET status = 'paid', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [payment.id],
      );

      console.log("Checking reservation_type:", payment.reservation_type);
      console.log("Is room?", payment.reservation_type === "room");
      console.log("Is table?", payment.reservation_type === "table");
      console.log("Is menu?", payment.reservation_type === "menu");

      if (payment.reservation_type === "room") {
        await conn.query(
          `UPDATE room_reservations
           SET payment_status = 'paid'
           WHERE id = ? AND user_id = ?`,
          [payment.reservation_id, req.user.id],
        );
      } else if (payment.reservation_type === "table") {
        await conn.query(
          `UPDATE table_reservations
           SET payment_status = 'paid'
           WHERE id = ? AND user_id = ?`,
          [payment.reservation_id, req.user.id],
        );
      } else if (payment.reservation_type === "menu") {
        await conn.query(
          `UPDATE menu_selections
           SET status = 'confirm'
           WHERE id = ? AND user_id = ?`,
          [payment.reservation_id, req.user.id],
        );
      } else {
        return res
          .status(400)
          .json({ message: "Invalid reservation type on payment record." });
      }

      return res.json({
        ok: true,
        reservationId: payment.reservation_id,
        reservationType: payment.reservation_type,
        paymentStatus: "paid",
      });
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("Manual confirm error:", error);
    return res
      .status(500)
      .json({ message: "Unable to confirm payment on the server." });
  }
});

app.post("/api/payments/menu/confirm", authMiddleware, async (req, res) => {
  const checkoutSessionId = req.body?.checkoutSessionId;

  if (!checkoutSessionId) {
    return res
      .status(400)
      .json({ message: "Checkout session identifier is required." });
  }

  try {
    const conn = await pool.getConnection();
    try {
      const [paymentRows] = await conn.query(
        `SELECT id, menu_selection_id FROM menu_payments
         WHERE checkout_id = ? AND user_id = ? AND status = 'pending'
         LIMIT 1`,
        [checkoutSessionId, req.user.id],
      );

      if (!paymentRows.length) {
        return res.status(404).json({
          message: "Menu payment record not found for this session.",
        });
      }

      const payment = paymentRows[0];

      await conn.query(
        `UPDATE menu_payments
         SET status = 'paid', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [payment.id],
      );

      await conn.query(
        `UPDATE menu_selections
         SET status = 'confirm'
         WHERE id = ? AND user_id = ?`,
        [payment.menu_selection_id, req.user.id],
      );

      return res.json({
        ok: true,
        menuSelectionId: payment.menu_selection_id,
        paymentStatus: "paid",
      });
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("Menu payment confirm error:", error);
    return res.status(500).json({ message: "Unable to confirm menu payment." });
  }
});

app.get(
  "/api/admin/room-reservations",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const conn = await pool.getConnection();
      try {
        const [rows] = await conn.query(`
        SELECT id, user_id, user_name, room_type, guests,
               reservation_date, reservation_time, full_name, email,
               phone_number, special_requests, payment_status, created_at
        FROM room_reservations
        ORDER BY reservation_date DESC, reservation_time DESC, id DESC
      `);

        return res.json({ reservations: rows });
      } finally {
        conn.release();
      }
    } catch (error) {
      console.error(error);
      return res
        .status(500)
        .json({ message: "Unable to fetch admin room reservations" });
    }
  },
);

app.get(
  "/api/admin/table-reservations",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const conn = await pool.getConnection();
      try {
        const [rows] = await conn.query(`
        SELECT id, user_id, user_name, restaurant_name, guests,
               reservation_date, reservation_time, full_name, email,
               phone_number, special_requests, agree_policy,
               selected_menu, menu_total, payment_status, created_at
        FROM table_reservations
        ORDER BY reservation_date DESC, reservation_time DESC, id DESC
      `);

        return res.json({ reservations: rows });
      } finally {
        conn.release();
      }
    } catch (error) {
      console.error(error);
      return res
        .status(500)
        .json({ message: "Unable to fetch admin table reservations" });
    }
  },
);

app.get(
  "/api/admin/users",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const conn = await pool.getConnection();
      try {
        const [rows] = await conn.query(
          `SELECT id, name, email, contact, role, created_at
           FROM users
           ORDER BY created_at DESC`,
        );
        res.json({ users: rows });
      } finally {
        conn.release();
      }
    } catch (error) {
      console.error("Get users error:", error);
      res.status(500).json({ message: "Unable to fetch users." });
    }
  },
);

app.put(
  "/api/admin/users/:id",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const userId = req.params.id;
    const { name, email, contact, password } = req.body;

    try {
      const fields = [];
      const params = [];

      if (name !== undefined) {
        fields.push("name = ?");
        params.push(name);
      }
      if (email !== undefined) {
        fields.push("email = ?");
        params.push(email);
      }
      if (contact !== undefined) {
        fields.push("contact = ?");
        params.push(contact);
      }
      if (password) {
        const password_hash = await bcrypt.hash(password, 10);
        fields.push("password_hash = ?");
        params.push(password_hash);
      }

      if (!fields.length) {
        return res.status(400).json({ message: "No fields to update." });
      }

      params.push(userId);

      const conn = await pool.getConnection();
      try {
        await conn.query(
          `UPDATE users SET ${fields.join(", ")} WHERE id = ?`,
          params,
        );
        const [rows] = await conn.query(
          `SELECT id, name, email, contact, role, created_at
           FROM users
           WHERE id = ?
           LIMIT 1`,
          [userId],
        );
        if (!rows.length) {
          return res.status(404).json({ message: "User not found." });
        }
        res.json({ user: rows[0] });
      } finally {
        conn.release();
      }
    } catch (error) {
      console.error("Update user error:", error);
      res.status(500).json({ message: "Unable to update user." });
    }
  },
);

app.delete(
  "/api/admin/users/:id",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const userId = req.params.id;

    try {
      const conn = await pool.getConnection();
      try {
        // Get user data before archiving
        const [users] = await conn.query("SELECT * FROM users WHERE id = ?", [
          userId,
        ]);

        if (!users.length) {
          return res.status(404).json({ message: "User not found." });
        }

        const user = users[0];

        // Archive the user
        await conn.query(
          "INSERT INTO archived_users (id, name, email, contact, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            user.id,
            user.name,
            user.email,
            user.contact,
            user.password_hash,
            user.role,
            user.created_at,
          ],
        );

        // Delete from users table
        await conn.query("DELETE FROM users WHERE id = ?", [userId]);

        res.json({ ok: true, message: "User archived successfully." });
      } finally {
        conn.release();
      }
    } catch (error) {
      console.error("Delete user error:", error);
      res.status(500).json({ message: "Unable to delete user." });
    }
  },
);

app.get(
  "/api/admin/archived-users",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const conn = await pool.getConnection();
      try {
        const [rows] = await conn.query(
          "SELECT id, name, email, contact, role, created_at, MAX(archived_at) as archived_at FROM archived_users GROUP BY id, name, email, contact, role, created_at ORDER BY archived_at DESC",
        );
        res.json({ users: rows });
      } finally {
        conn.release();
      }
    } catch (error) {
      console.error("Fetch archived users error:", error);
      res.status(500).json({ message: "Unable to fetch archived users." });
    }
  },
);

app.post(
  "/api/admin/restore-user/:id",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const userId = req.params.id;

    try {
      const conn = await pool.getConnection();
      try {
        // Get archived user data
        const [archivedUsers] = await conn.query(
          "SELECT * FROM archived_users WHERE id = ? LIMIT 1",
          [userId],
        );

        if (!archivedUsers.length) {
          return res.status(404).json({ message: "Archived user not found." });
        }

        const user = archivedUsers[0];

        // Restore user to users table
        await conn.query(
          "INSERT INTO users (id, name, email, contact, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            user.id,
            user.name,
            user.email,
            user.contact,
            user.password_hash,
            user.role,
            user.created_at,
          ],
        );

        // Remove from archived_users
        await conn.query("DELETE FROM archived_users WHERE id = ?", [userId]);

        res.json({
          ok: true,
          message: "User restored successfully.",
          user: user,
        });
      } finally {
        conn.release();
      }
    } catch (error) {
      console.error("Restore user error:", error);
      if (error.code === "ER_DUP_ENTRY") {
        return res.status(400).json({
          message:
            "User email already exists. Cannot restore this user at this time.",
        });
      }
      res.status(500).json({ message: "Unable to restore user." });
    }
  },
);

app.get(
  "/api/admin/export-backup",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    try {
      const conn = await pool.getConnection();
      try {
        // Fetch all data
        const [menuSelections] = await conn.query(
          "SELECT * FROM menu_selections ORDER BY created_at DESC",
        );
        const [roomReservations] = await conn.query(
          "SELECT * FROM room_reservations ORDER BY created_at DESC",
        );
        const [tableReservations] = await conn.query(
          "SELECT * FROM table_reservations ORDER BY created_at DESC",
        );

        // Create workbook
        const workbook = new ExcelJS.Workbook();

        // ===== MENU SELECTIONS SHEET =====
        const menuSheet = workbook.addWorksheet("Menu Selections");
        menuSheet.columns = [
          { header: "ID", key: "id", width: 10 },
          { header: "User ID", key: "user_id", width: 12 },
          { header: "Selected Menu", key: "selected_menu", width: 30 },
          { header: "Total Amount", key: "total_amount", width: 15 },
          { header: "Status", key: "status", width: 12 },
          { header: "Feedback Rating", key: "feedback_rating", width: 16 },
          { header: "Feedback Comment", key: "feedback_comment", width: 30 },
          { header: "Feedback Date", key: "feedback_date", width: 20 },
          { header: "Created At", key: "created_at", width: 20 },
        ];

        // Style header row for Menu
        menuSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        menuSheet.getRow(1).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF4472C4" },
        };

        menuSelections.forEach((item) => {
          menuSheet.addRow({
            id: item.id,
            user_id: item.user_id,
            selected_menu:
              typeof item.selected_menu === "string"
                ? item.selected_menu
                : JSON.stringify(item.selected_menu),
            total_amount: item.total_amount,
            status: item.status,
            feedback_rating: item.feedback_rating || "-",
            feedback_comment: item.feedback_comment || "-",
            feedback_date: item.feedback_date || "-",
            created_at: item.created_at,
          });
        });

        // ===== ROOM RESERVATIONS SHEET =====
        const roomSheet = workbook.addWorksheet("Room Reservations");
        roomSheet.columns = [
          { header: "ID", key: "id", width: 10 },
          { header: "User ID", key: "user_id", width: 12 },
          { header: "User Name", key: "user_name", width: 15 },
          { header: "Room Type", key: "room_type", width: 15 },
          { header: "Guests", key: "guests", width: 10 },
          { header: "Reservation Date", key: "reservation_date", width: 18 },
          { header: "Reservation Time", key: "reservation_time", width: 18 },
          { header: "Full Name", key: "full_name", width: 15 },
          { header: "Email", key: "email", width: 20 },
          { header: "Phone Number", key: "phone_number", width: 15 },
          { header: "Special Requests", key: "special_requests", width: 25 },
          { header: "Payment Status", key: "payment_status", width: 15 },
          { header: "Feedback Rating", key: "feedback_rating", width: 16 },
          { header: "Feedback Comment", key: "feedback_comment", width: 25 },
          { header: "Created At", key: "created_at", width: 20 },
        ];

        // Style header row for Room
        roomSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        roomSheet.getRow(1).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF70AD47" },
        };

        roomReservations.forEach((item) => {
          roomSheet.addRow({
            id: item.id,
            user_id: item.user_id,
            user_name: item.user_name,
            room_type: item.room_type,
            guests: item.guests,
            reservation_date: item.reservation_date,
            reservation_time: item.reservation_time,
            full_name: item.full_name,
            email: item.email || "-",
            phone_number: item.phone_number || "-",
            special_requests: item.special_requests || "-",
            payment_status: item.payment_status,
            feedback_rating: item.feedback_rating || "-",
            feedback_comment: item.feedback_comment || "-",
            created_at: item.created_at,
          });
        });

        // ===== TABLE RESERVATIONS SHEET =====
        const tableSheet = workbook.addWorksheet("Table Reservations");
        tableSheet.columns = [
          { header: "ID", key: "id", width: 10 },
          { header: "User ID", key: "user_id", width: 12 },
          { header: "User Name", key: "user_name", width: 15 },
          { header: "Restaurant Name", key: "restaurant_name", width: 20 },
          { header: "Guests", key: "guests", width: 10 },
          { header: "Reservation Date", key: "reservation_date", width: 18 },
          { header: "Reservation Time", key: "reservation_time", width: 18 },
          { header: "Full Name", key: "full_name", width: 15 },
          { header: "Email", key: "email", width: 20 },
          { header: "Phone Number", key: "phone_number", width: 15 },
          { header: "Special Requests", key: "special_requests", width: 25 },
          { header: "Selected Menu", key: "selected_menu", width: 30 },
          { header: "Menu Total", key: "menu_total", width: 12 },
          { header: "Payment Status", key: "payment_status", width: 15 },
          { header: "Feedback Rating", key: "feedback_rating", width: 16 },
          { header: "Feedback Comment", key: "feedback_comment", width: 25 },
          { header: "Created At", key: "created_at", width: 20 },
        ];

        // Style header row for Table
        tableSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        tableSheet.getRow(1).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFC5504B" },
        };

        tableReservations.forEach((item) => {
          tableSheet.addRow({
            id: item.id,
            user_id: item.user_id || "-",
            user_name: item.user_name || "-",
            restaurant_name: item.restaurant_name,
            guests: item.guests,
            reservation_date: item.reservation_date,
            reservation_time: item.reservation_time,
            full_name: item.full_name,
            email: item.email || "-",
            phone_number: item.phone_number || "-",
            special_requests: item.special_requests || "-",
            selected_menu:
              typeof item.selected_menu === "string"
                ? item.selected_menu
                : JSON.stringify(item.selected_menu),
            menu_total: item.menu_total || 0,
            payment_status: item.payment_status,
            feedback_rating: item.feedback_rating || "-",
            feedback_comment: item.feedback_comment || "-",
            created_at: item.created_at,
          });
        });

        // Format all sheets for better readability
        [menuSheet, roomSheet, tableSheet].forEach((sheet) => {
          sheet.columns.forEach((column) => {
            column.alignment = {
              horizontal: "left",
              vertical: "top",
              wrapText: true,
            };
          });
        });

        // Send file
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="backup-${new Date().toISOString().split("T")[0]}.xlsx"`,
        );

        await workbook.xlsx.write(res);
        res.end();
      } finally {
        conn.release();
      }
    } catch (error) {
      console.error("Export backup error:", error);
      res.status(500).json({ message: "Unable to export backup." });
    }
  },
);

app.put(
  "/api/admin/room-reservations/:id",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const reservationId = req.params.id;
    const { reservation_date, reservation_time } = req.body;

    if (!reservation_date && !reservation_time) {
      return res
        .status(400)
        .json({ message: "Provide reservation_date or reservation_time." });
    }

    try {
      const fields = [];
      const params = [];

      if (reservation_date) {
        fields.push("reservation_date = ?");
        params.push(reservation_date);
      }
      if (reservation_time) {
        fields.push("reservation_time = ?");
        params.push(reservation_time);
      }

      params.push(reservationId);

      const conn = await pool.getConnection();
      try {
        const [result] = await conn.query(
          `
          UPDATE room_reservations
          SET ${fields.join(", ")}
          WHERE id = ?
        `,
          params,
        );

        if (result.affectedRows === 0) {
          return res.status(404).json({ message: "Reservation not found." });
        }

        const [rows] = await conn.query(
          `
          SELECT id, user_id, user_name, room_type, guests,
                 reservation_date, reservation_time, full_name, email,
                 phone_number, special_requests, payment_status, created_at
          FROM room_reservations
          WHERE id = ?
          LIMIT 1
        `,
          [reservationId],
        );

        if (!rows.length) {
          return res
            .status(404)
            .json({ message: "Reservation not found after update." });
        }

        const updated = rows[0];
        res.json({ reservation: updated });
      } finally {
        conn.release();
      }
    } catch (error) {
      console.error("Update room reservation error:", error);
      return res
        .status(500)
        .json({ message: "Unable to update room reservation." });
    }
  },
);

app.put(
  "/api/admin/table-reservations/:id",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const reservationId = req.params.id;
    const { reservation_date, reservation_time } = req.body;

    if (!reservation_date && !reservation_time) {
      return res
        .status(400)
        .json({ message: "Provide reservation_date or reservation_time." });
    }

    try {
      const fields = [];
      const params = [];

      if (reservation_date) {
        fields.push("reservation_date = ?");
        params.push(reservation_date);
      }
      if (reservation_time) {
        fields.push("reservation_time = ?");
        params.push(reservation_time);
      }

      params.push(reservationId);

      const conn = await pool.getConnection();
      try {
        const [result] = await conn.query(
          `
          UPDATE table_reservations
          SET ${fields.join(", ")}
          WHERE id = ?
        `,
          params,
        );

        if (result.affectedRows === 0) {
          return res.status(404).json({ message: "Reservation not found." });
        }

        const [rows] = await conn.query(
          `
          SELECT id, user_id, user_name, restaurant_name, guests,
                 reservation_date, reservation_time, full_name, email,
                 phone_number, special_requests, agree_policy,
                 selected_menu, menu_total, payment_status, created_at
          FROM table_reservations
          WHERE id = ?
          LIMIT 1
        `,
          [reservationId],
        );

        if (!rows.length) {
          return res
            .status(404)
            .json({ message: "Reservation not found after update." });
        }

        const updated = rows[0];
        res.json({ reservation: updated });
      } finally {
        conn.release();
      }
    } catch (error) {
      console.error("Update table reservation error:", error);
      return res
        .status(500)
        .json({ message: "Unable to update table reservation." });
    }
  },
);

app.get(
  "/api/admin/sales-report",
  authMiddleware,
  adminMiddleware,
  async (req, res) => {
    const { type = "room", timeRange = "days" } = req.query;

    const now = new Date();
    let startDate = new Date();

    if (timeRange === "days") {
      startDate.setDate(startDate.getDate() - 1);
    } else if (timeRange === "weekly") {
      startDate.setDate(startDate.getDate() - 7);
    } else if (timeRange === "monthly") {
      startDate.setDate(startDate.getDate() - 30);
    } else if (timeRange === "years") {
      startDate.setFullYear(startDate.getFullYear() - 1);
    }

    const startDateStr = startDate.toISOString().split("T")[0];
    const nowStr = now.toISOString().split("T")[0];

    try {
      const conn = await pool.getConnection();
      try {
        let query;
        let data = [];

        if (type === "room") {
          const [rows] = await conn.query(
            `SELECT 
            rr.id,
            rr.full_name,
            rr.reservation_date,
            rr.reservation_time,
            rr.guests,
            rr.room_type,
            COALESCE(p.amount, 0) as amount,
            p.status as payment_status,
            p.created_at as payment_date,
            rr.created_at
          FROM room_reservations rr
          LEFT JOIN payments p ON rr.user_id = p.user_id 
            AND p.reservation_id = rr.id 
            AND p.reservation_type = 'room'
          WHERE DATE(rr.created_at) BETWEEN ? AND ?
          ORDER BY rr.created_at DESC`,
            [startDateStr, nowStr],
          );
          data = rows;
        } else if (type === "restaurant") {
          const [rows] = await conn.query(
            `SELECT 
            tr.id,
            tr.full_name,
            tr.reservation_date,
            tr.reservation_time,
            tr.guests,
            tr.restaurant_name,
            tr.selected_menu,
            tr.menu_total as amount,
            tr.payment_status,
            tr.created_at
          FROM table_reservations tr
          WHERE DATE(tr.created_at) BETWEEN ? AND ?
          ORDER BY tr.created_at DESC`,
            [startDateStr, nowStr],
          );
          data = rows;
        } else if (type === "menu") {
          const [rows] = await conn.query(
            `SELECT 
            ms.id,
            u.name as full_name,
            ms.selected_menu,
            ms.total_amount as amount,
            mp.status as payment_status,
            mp.created_at as payment_date,
            ms.created_at
          FROM menu_selections ms
          JOIN users u ON ms.user_id = u.id
          LEFT JOIN menu_payments mp ON ms.id = mp.menu_selection_id
          WHERE DATE(ms.created_at) BETWEEN ? AND ?
          ORDER BY ms.created_at DESC`,
            [startDateStr, nowStr],
          );
          data = rows;
        }

        data = data.map((row) => ({
          ...row,
          selected_menu:
            typeof row.selected_menu === "string"
              ? JSON.parse(row.selected_menu)
              : row.selected_menu,
        }));

        const totalAmount = data.reduce(
          (sum, row) => sum + (Number(row.amount) || 0),
          0,
        );
        const paidCount = data.filter(
          (row) => row.payment_status === "paid",
        ).length;
        const totalCount = data.length;

        return res.json({
          type,
          timeRange,
          startDate: startDateStr,
          endDate: nowStr,
          data,
          summary: {
            totalCount,
            paidCount,
            totalAmount,
            averageAmount: totalCount > 0 ? totalAmount / totalCount : 0,
          },
        });
      } finally {
        conn.release();
      }
    } catch (error) {
      console.error("Sales report error:", error);
      return res.status(500).json({ message: "Unable to fetch sales report." });
    }
  },
);

app.post("/api/feedback/room", authMiddleware, async (req, res) => {
  const { reservationId, rating, comment } = req.body;
  const userId = req.user.id;

  if (!reservationId || !rating || rating < 1 || rating > 5) {
    return res
      .status(400)
      .json({ message: "Invalid rating or reservation ID" });
  }

  try {
    const conn = await pool.getConnection();
    await conn.query(
      "UPDATE room_reservations SET feedback_rating = ?, feedback_comment = ?, feedback_date = NOW() WHERE id = ? AND user_id = ? AND payment_status = 'paid'",
      [rating, comment || null, reservationId, userId],
    );
    conn.release();
    res.json({ ok: true, message: "Feedback submitted successfully" });
  } catch (error) {
    console.error("Feedback error:", error);
    res.status(500).json({ message: "Unable to submit feedback" });
  }
});

app.post("/api/feedback/table", authMiddleware, async (req, res) => {
  const { reservationId, rating, comment } = req.body;
  const userId = req.user.id;

  if (!reservationId || !rating || rating < 1 || rating > 5) {
    return res
      .status(400)
      .json({ message: "Invalid rating or reservation ID" });
  }

  try {
    const conn = await pool.getConnection();
    await conn.query(
      "UPDATE table_reservations SET feedback_rating = ?, feedback_comment = ?, feedback_date = NOW() WHERE id = ? AND user_id = ? AND payment_status = 'paid'",
      [rating, comment || null, reservationId, userId],
    );
    conn.release();
    res.json({ ok: true, message: "Feedback submitted successfully" });
  } catch (error) {
    console.error("Feedback error:", error);
    res.status(500).json({ message: "Unable to submit feedback" });
  }
});

app.post("/api/feedback/menu", authMiddleware, async (req, res) => {
  const { menuSelectionId, rating, comment } = req.body;
  const userId = req.user.id;

  if (!menuSelectionId || !rating || rating < 1 || rating > 5) {
    return res
      .status(400)
      .json({ message: "Invalid rating or menu selection ID" });
  }

  try {
    const conn = await pool.getConnection();
    await conn.query(
      "UPDATE menu_selections SET feedback_rating = ?, feedback_comment = ?, feedback_date = NOW() WHERE id = ? AND user_id = ? AND status = 'paid'",
      [rating, comment || null, menuSelectionId, userId],
    );
    conn.release();
    res.json({ ok: true, message: "Feedback submitted successfully" });
  } catch (error) {
    console.error("Feedback error:", error);
    res.status(500).json({ message: "Unable to submit feedback" });
  }
});

app.get("/api/feedback/room/:id", authMiddleware, async (req, res) => {
  const reservationId = req.params.id;
  const userId = req.user.id;

  try {
    const conn = await pool.getConnection();
    const [rows] = await conn.query(
      "SELECT id, feedback_rating, feedback_comment, feedback_date FROM room_reservations WHERE id = ? AND user_id = ?",
      [reservationId, userId],
    );
    conn.release();

    if (rows.length === 0) {
      return res.status(404).json({ message: "Reservation not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Get room feedback error:", error);
    res.status(500).json({ message: "Unable to fetch feedback" });
  }
});

app.get("/api/feedback/table/:id", authMiddleware, async (req, res) => {
  const reservationId = req.params.id;
  const userId = req.user.id;

  try {
    const conn = await pool.getConnection();
    const [rows] = await conn.query(
      "SELECT id, feedback_rating, feedback_comment, feedback_date FROM table_reservations WHERE id = ? AND user_id = ?",
      [reservationId, userId],
    );
    conn.release();

    if (rows.length === 0) {
      return res.status(404).json({ message: "Reservation not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Get table feedback error:", error);
    res.status(500).json({ message: "Unable to fetch feedback" });
  }
});

app.get("/api/feedback/menu/:id", authMiddleware, async (req, res) => {
  const menuSelectionId = req.params.id;
  const userId = req.user.id;

  try {
    const conn = await pool.getConnection();
    const [rows] = await conn.query(
      "SELECT id, feedback_rating, feedback_comment, feedback_date FROM menu_selections WHERE id = ? AND user_id = ?",
      [menuSelectionId, userId],
    );
    conn.release();

    if (rows.length === 0) {
      return res.status(404).json({ message: "Menu selection not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Get menu feedback error:", error);
    res.status(500).json({ message: "Unable to fetch feedback" });
  }
});

app.listen(PORT, () => {
  console.log(`API on http://localhost:${PORT}`);
});
