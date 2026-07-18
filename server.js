const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const axios = require("axios");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const webpush = require("web-push");
const cron = require("node-cron");
require("dotenv").config();

const { PrismaClient } = require("@prisma/client");

console.log("Starting SmartPantry server...");
console.log("DATABASE_URL:", process.env.DATABASE_URL ? "Set" : "NOT SET");
console.log("GEMINI_API_KEY:", process.env.GEMINI_API_KEY ? "Set" : "NOT SET");
if (
  process.env.GEMINI_API_KEY &&
  !process.env.GEMINI_API_KEY.startsWith("AIza")
) {
  console.warn(
    "WARNING: GEMINI_API_KEY should be a Google AI Studio key (starts with AIza). AI features may fail.",
  );
}
console.log("JWT_SECRET:", process.env.JWT_SECRET ? "Set" : "NOT SET");
console.log(
  "VAPID_PUBLIC_KEY:",
  process.env.VAPID_PUBLIC_KEY ? "Set" : "NOT SET",
);
console.log(
  "VAPID_PRIVATE_KEY:",
  process.env.VAPID_PRIVATE_KEY ? "Set" : "NOT SET",
);

if (!process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not set in .env");
  process.exit(1);
}

// ============ WEB PUSH SETUP ============
// Push notifications only work if VAPID keys are configured.
// Generate them once with: npx web-push generate-vapid-keys
const pushEnabled = !!(
  process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
);
if (pushEnabled) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_CONTACT_EMAIL || "admin@example.com"}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  console.log("Web push configured");
} else {
  console.warn(
    "Web push NOT configured — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in .env to enable notifications",
  );
}

let prisma;
try {
  prisma = new PrismaClient();
  console.log("Prisma client created");
} catch (error) {
  console.error("Error creating Prisma client:", error);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3001;

// ============ MIDDLEWARE ============

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  }),
);
app.use(express.json());
app.use(express.static("public"));

// Simple in-memory rate limiter for AI endpoints
const rateLimitMap = new Map();
function rateLimit(windowMs, maxRequests) {
  return (req, res, next) => {
    const key = req.ip || req.headers["x-forwarded-for"] || "unknown";
    const now = Date.now();
    const entry = rateLimitMap.get(key) || {
      count: 0,
      resetAt: now + windowMs,
    };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }
    entry.count++;
    rateLimitMap.set(key, entry);
    if (entry.count > maxRequests) {
      return res
        .status(429)
        .json({ error: "Too many requests. Please wait a moment." });
    }
    next();
  };
}

// Multer — memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

console.log("Middleware configured");

// ============ AUTH MIDDLEWARE ============

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    res
      .status(401)
      .json({ error: "Invalid or expired token. Please log in again." });
  }
}

// ============ AI FALLBACK HELPER ============

/**
 * Retries a Gemini request with a fallback model if a rate limit (429) is encountered.
 * Uses the exact models requested: 3.5 flash, 3.5 flash lite, 2.5 flash, 2.5 flash lite.
 */
async function callGeminiWithFallback(
  payload,
  models = [
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
  ],
) {
  const apiKey = process.env.GEMINI_API_KEY;
  let lastError = null;

  for (const model of models) {
    try {
      console.log(`Attempting AI request with model: ${model}`);
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        payload,
        { timeout: 30_000 },
      );
      return response.data;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;

      // If the model is not found or not supported, try the next one
      if (
        status === 404 ||
        (error.response?.data?.error?.message &&
          error.response.data.error.message.includes("not found"))
      ) {
        console.warn(`Model ${model} not found. Trying next fallback...`);
        continue;
      }

      // If rate limited, try the next one
      if (status === 429) {
        console.warn(
          `Rate limit exceeded for ${model}. Trying next fallback...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      // For other errors, log and try next model if it's an AI-side issue
      console.warn(
        `Error with ${model}: ${error.message}. Trying next fallback...`,
      );
      continue;
    }
  }
  throw lastError;
}

// ============ INPUT VALIDATION HELPERS ============

function validateString(val, fieldName, { min = 1, max = 500 } = {}) {
  if (typeof val !== "string" || val.trim().length < min)
    return `${fieldName} is required`;
  if (val.trim().length > max)
    return `${fieldName} must be ${max} characters or fewer`;
  return null;
}

function validateDate(val, fieldName) {
  if (!val) return `${fieldName} is required`;
  const d = new Date(val);
  if (isNaN(d.getTime())) return `${fieldName} must be a valid date`;
  return null;
}

function validatePositiveInt(val, fieldName) {
  const n = parseInt(val);
  if (isNaN(n) || n < 1) return `${fieldName} must be a positive number`;
  return null;
}

const VALID_CATEGORIES = [
  "vegetables",
  "fruits",
  "dairy",
  "meat",
  "pantry",
  "other",
];

function normalizeCategory(value) {
  if (typeof value !== "string") return "other";
  const normalized = value.trim().toLowerCase();
  if (VALID_CATEGORIES.includes(normalized)) return normalized;
  if (["veg", "veggie", "vegetable", "produce"].includes(normalized))
    return "vegetables";
  if (["fruit"].includes(normalized)) return "fruits";
  if (["milk", "cheese", "egg", "eggs"].includes(normalized)) return "dairy";
  return "other";
}

function normalizeDateString(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = value.trim().match(/\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toISOString().split("T")[0];
}

function parseGeminiJson(rawText) {
  const cleaned = rawText
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function getGeminiErrorMessage(error) {
  const status = error.response?.status;
  const msg = error.response?.data?.error?.message;
  if (status === 400 || status === 403) {
    return (
      msg ||
      "Invalid Gemini API key. Create one at https://aistudio.google.com/apikey (starts with AIza)."
    );
  }
  if (status === 429)
    return "Gemini rate limit exceeded. Please wait and try again.";
  return msg || "Gemini request failed";
}

const uploadsDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ============ AUTH ROUTES ============

// POST /api/auth/register
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const errors = [];
    const nameErr = validateString(name, "Name", { max: 100 });
    if (nameErr) errors.push(nameErr);
    const emailErr = validateString(email, "Email", { max: 200 });
    if (emailErr) errors.push(emailErr);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      errors.push("Email must be a valid address");
    if (!password || password.length < 8)
      errors.push("Password must be at least 8 characters");
    if (errors.length)
      return res.status(400).json({ error: errors.join(". ") });

    const existing = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    if (existing)
      return res
        .status(409)
        .json({ error: "An account with this email already exists" });

    const hashed = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: email.toLowerCase().trim(),
        password: hashed,
      },
    });

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

// POST /api/auth/login
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password are required" });

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    const valid = user && (await bcrypt.compare(password, user.password));
    if (!valid)
      return res.status(401).json({ error: "Invalid email or password" });

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// GET /api/auth/me
app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, name: true, email: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ PANTRY ROUTES ============

// GET /api/pantry
app.get("/api/pantry", requireAuth, async (req, res) => {
  try {
    const { search, category, sort } = req.query;

    const where = { userId: req.userId };
    if (category && category !== "all") where.category = category;
    if (search && search.trim()) {
      where.name = { contains: search.trim(), mode: "insensitive" };
    }

    const orderBy =
      sort === "name"
        ? { name: "asc" }
        : sort === "quantity"
          ? { quantity: "desc" }
          : { expirationDate: "asc" }; // default + 'expiry'

    const items = await prisma.pantryItem.findMany({ where, orderBy });
    res.json(items);
  } catch (error) {
    console.error("Error fetching pantry items:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/pantry
app.post("/api/pantry", requireAuth, async (req, res) => {
  try {
    const { name, quantity, unit, category, expirationDate, notes, imageUrl } =
      req.body;

    const errors = [];
    const nameErr = validateString(name, "Item name", { max: 200 });
    if (nameErr) errors.push(nameErr);
    const dateErr = validateDate(expirationDate, "Expiration date");
    if (dateErr) errors.push(dateErr);
    const qtyErr = validatePositiveInt(quantity, "Quantity");
    if (qtyErr) errors.push(qtyErr);
    if (errors.length)
      return res.status(400).json({ error: errors.join(". ") });

    const item = await prisma.pantryItem.create({
      data: {
        userId: req.userId,
        name: name.trim(),
        quantity: parseInt(quantity),
        unit: unit || "piece",
        category: category || "other",
        expirationDate: new Date(expirationDate),
        notes: notes ? notes.trim() : null,
        imageUrl: imageUrl || null,
      },
    });

    res.json(item);
  } catch (error) {
    console.error("Error creating item:", error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/pantry/:id
app.put("/api/pantry/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.pantryItem.findUnique({ where: { id } });
    if (!existing || existing.userId !== req.userId)
      return res.status(404).json({ error: "Item not found" });

    const { name, quantity, unit, category, expirationDate, notes } = req.body;

    const errors = [];
    if (name !== undefined) {
      const nameErr = validateString(name, "Item name", { max: 200 });
      if (nameErr) errors.push(nameErr);
    }
    if (expirationDate !== undefined) {
      const dateErr = validateDate(expirationDate, "Expiration date");
      if (dateErr) errors.push(dateErr);
    }
    if (quantity !== undefined) {
      const qtyErr = validatePositiveInt(quantity, "Quantity");
      if (qtyErr) errors.push(qtyErr);
    }
    if (errors.length)
      return res.status(400).json({ error: errors.join(". ") });

    const item = await prisma.pantryItem.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(quantity !== undefined && { quantity: parseInt(quantity) }),
        ...(unit !== undefined && { unit }),
        ...(category !== undefined && { category }),
        ...(expirationDate !== undefined && {
          expirationDate: new Date(expirationDate),
        }),
        ...(notes !== undefined && { notes: notes.trim() }),
      },
    });

    res.json(item);
  } catch (error) {
    console.error("Error updating item:", error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/pantry/:id
app.delete("/api/pantry/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.pantryItem.findUnique({ where: { id } });
    if (!existing || existing.userId !== req.userId)
      return res.status(404).json({ error: "Item not found" });

    await prisma.pantryItem.delete({ where: { id } });
    res.json({ message: "Item deleted" });
  } catch (error) {
    console.error("Error deleting item:", error);
    res.status(500).json({ error: error.message });
  }
});

// ============ SHOPPING LIST ============

app.get("/api/shopping-list", requireAuth, async (req, res) => {
  try {
    const today = new Date();
    const sevenDays = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

    const items = await prisma.pantryItem.findMany({
      where: { userId: req.userId },
    });

    const list = items
      .filter((item) => new Date(item.expirationDate) <= sevenDays)
      .map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        unit: item.unit,
        reason:
          new Date(item.expirationDate) < today ? "expired" : "expiring_soon",
        currentQuantity: item.quantity,
      }));

    res.json(list);
  } catch (error) {
    console.error("Error generating shopping list:", error);
    res.status(500).json({ error: error.message });
  }
});

// ============ WASTE ANALYTICS ============

app.get("/api/analytics", requireAuth, async (req, res) => {
  try {
    const items = await prisma.pantryItem.findMany({
      where: { userId: req.userId },
    });
    const today = new Date();

    let fresh = 0,
      expiringSoon = 0,
      expired = 0;
    const sevenDays = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    items.forEach((item) => {
      const exp = new Date(item.expirationDate);
      if (exp < today) expired++;
      else if (exp <= sevenDays) expiringSoon++;
      else fresh++;
    });

    const categoryBreakdown = items.reduce((acc, item) => {
      acc[item.category] = (acc[item.category] || 0) + 1;
      return acc;
    }, {});

    res.json({
      summary: { total: items.length, fresh, expiringSoon, expired },
      categoryBreakdown,
      expiredItems: items
        .filter((item) => new Date(item.expirationDate) < today)
        .map((item) => ({
          name: item.name,
          category: item.category,
          expirationDate: item.expirationDate,
        })),
    });
  } catch (error) {
    console.error("Error fetching analytics:", error);
    res.status(500).json({ error: error.message });
  }
});

// ============ FILE UPLOAD ============

app.post(
  "/api/upload",
  requireAuth,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const filename = `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      fs.writeFileSync(path.join(uploadsDir, filename), req.file.buffer);
      res.json({ url: `/uploads/${filename}` });
    } catch (error) {
      console.error("Error uploading file:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

// ============ AI FEATURES ============

// POST /api/analyze-photo — OCR scanning logic for back of packages
app.post(
  "/api/analyze-photo",
  requireAuth,
  rateLimit(60_000, 10),
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const geminiApiKey = process.env.GEMINI_API_KEY;
      if (!geminiApiKey)
        return res.status(500).json({ error: "Gemini API key not configured" });

      const base64Image = req.file.buffer.toString("base64");
      const mimeType = req.file.mimetype || "image/jpeg";

      const todayStr = new Date().toISOString().split("T")[0];

      const prompt = `You are looking at the back/label of a food or grocery product.
Perform two tasks:
1. Identify what the product is (the Item Name).
2. Scan all printed text in the image to find an expiration date, best before date, or use-by date (look for tags like EXP, BB, BBD, Best Before, or clear ink-jet date stamps). 

Convert any date found into a standardized 'YYYY-MM-DD' format. 
If NO expiration date is stamped in the text anywhere, only then estimate a realistic expiration baseline from today's context date (${todayStr}).

Return ONLY a valid JSON object matching this exact format with no markdown blocks:
{
  "name": "Product Name",
  "category": "vegetables" or "fruits" or "dairy" or "meat" or "pantry" or "other",
  "expirationDate": "YYYY-MM-DD"
}`;

      const data = await callGeminiWithFallback({
        contents: [
          {
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data: base64Image } },
            ],
          },
        ],
      });

      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const extractedData = parseGeminiJson(rawText);

      if (!extractedData) {
        return res.json({
          fallback: true,
          message:
            "Could not read product details from the photo. Fill in the form manually.",
          item: { name: "", category: "other", expirationDate: todayStr },
        });
      }

      const item = {
        name: (extractedData.name || "").trim() || "Unknown Product",
        category: normalizeCategory(extractedData.category),
        expirationDate:
          normalizeDateString(extractedData.expirationDate) || todayStr,
      };

      res.json({ success: true, item });
    } catch (error) {
      console.error(
        "Analyze photo error:",
        error.response?.data || error.message,
      );
      const todayStr = new Date().toISOString().split("T")[0];
      res.json({
        fallback: true,
        message: getGeminiErrorMessage(error),
        item: { name: "", category: "other", expirationDate: todayStr },
      });
    }
  },
);

// POST /api/generate-recipes
app.post(
  "/api/generate-recipes",
  requireAuth,
  rateLimit(60_000, 5),
  async (req, res) => {
    try {
      const { ingredients } = req.body;
      if (
        !ingredients ||
        typeof ingredients !== "string" ||
        ingredients.trim().length === 0
      )
        return res.status(400).json({ error: "No ingredients provided" });

      const geminiApiKey = process.env.GEMINI_API_KEY;
      if (!geminiApiKey)
        return res.status(500).json({ error: "Gemini API key not configured" });

      // Dedupe pantry item names before sending to the model
      const uniqueIngredients = [
        ...new Set(
          ingredients
            .split(",")
            .map((i) => i.trim())
            .filter(Boolean),
        ),
      ].join(", ");

      const data = await callGeminiWithFallback({
        contents: [
          {
            parts: [
              {
                text: `Here is a list of items currently in a home pantry: ${uniqueIngredients.slice(0, 800)}.

Some items may be raw cooking ingredients (vegetables, dairy, grains, spices), and some may be ready-to-eat packaged products (ice cream, biscuits, chocolate syrup, snack mixes). Not all items belong together in one dish.

Your task:
- Choose 6 DIFFERENT, realistic, commonly-made recipes or drinks.
- Each recipe should use only a small, sensible subset of the pantry list (2-6 items) that people would actually combine in real cooking. Do not force unrelated items together just because they're on the list.
- It is fine — and expected — to ignore items that don't fit any sensible recipe.
- Every recipe must include specific, realistic quantities per ingredient (e.g. "1 cup milk", "2 tbsp sugar"), not just a bare item name.
- Prefer variety: don't make all 6 recipes desserts if there are savory or drink options possible.

For each recipe use this EXACT format:
Title: [Recipe Name]
PrepTime: [X]
Servings: [X]
Ingredients: [comma-separated list, each with a quantity, e.g. "1 cup milk, 2 tbsp sugar, 1 ripe banana"]
Instructions: [clear numbered steps, e.g. "1. Do X. 2. Do Y."]

---

Separate each recipe with three dashes only.`,
              },
            ],
          },
        ],
      });

      const recipeText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const recipes = recipeText
        .split("---")
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block) => {
          const get = (key) => {
            const match = block.match(new RegExp(`${key}:\\s*(.+)`));
            return match ? match[1].trim() : "";
          };
          return {
            title: get("Title") || "Quick Meal",
            prepTime: parseInt(get("PrepTime")) || 20,
            servings: parseInt(get("Servings")) || 2,
            ingredients: get("Ingredients") || uniqueIngredients,
            instructions: get("Instructions") || block,
          };
        })
        .filter((r) => r.title && r.instructions);

      if (recipes.length === 0) {
        return res
          .status(500)
          .json({ error: "AI returned no recipes. Please try again." });
      }

      // Clear previous AI-generated recipes so old junk doesn't pile up alongside new ones
      await prisma.recipe.deleteMany({ where: { userId: req.userId } });

      for (const recipe of recipes) {
        await prisma.recipe
          .create({
            data: {
              userId: req.userId,
              title: recipe.title,
              description: "",
              ingredients: JSON.stringify(recipe.ingredients),
              instructions: recipe.instructions,
              prepTime: recipe.prepTime,
              cookTime: 20,
              servings: recipe.servings,
              difficulty: "medium",
              cuisine: "mixed",
            },
          })
          .catch(() => {});
      }

      res.json({ recipes });
    } catch (error) {
      console.error(
        "Generate recipes error:",
        error.response?.data || error.message,
      );
      res.status(500).json({ error: getGeminiErrorMessage(error) });
    }
  },
);
// GET /api/recipes
app.get("/api/recipes", requireAuth, async (req, res) => {
  try {
    const recipes = await prisma.recipe.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
    });
    res.json(
      recipes.map((r) => ({
        ...r,
        ingredients: (() => {
          try {
            return JSON.parse(r.ingredients);
          } catch {
            return r.ingredients;
          }
        })(),
      })),
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ NOTIFICATIONS (in-app) ============

app.get("/api/notifications", requireAuth, async (req, res) => {
  try {
    const items = await prisma.pantryItem.findMany({
      where: { userId: req.userId },
    });
    const today = new Date();
    const threeDays = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);

    const notifications = items
      .filter((item) => new Date(item.expirationDate) <= threeDays)
      .map((item) => {
        const exp = new Date(item.expirationDate);
        const isExpired = exp < today;
        const daysLeft = Math.ceil((exp - today) / (1000 * 60 * 60 * 24));
        return {
          id: item.id,
          type: isExpired ? "expired" : "expiring_soon",
          itemName: item.name,
          message: isExpired
            ? `${item.name} expired ${Math.abs(daysLeft)} day${Math.abs(daysLeft) !== 1 ? "s" : ""} ago`
            : `${item.name} expires in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}`,
          expirationDate: item.expirationDate,
          createdAt: new Date().toISOString(),
        };
      })
      .sort((a, b) => new Date(a.expirationDate) - new Date(b.expirationDate));

    res.json(notifications);
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ error: error.message });
  }
});

// ============ WEB PUSH (phone notifications) ============

// Expose the public VAPID key to the frontend so it can subscribe
app.get("/api/push/public-key", requireAuth, (req, res) => {
  if (!pushEnabled)
    return res
      .status(500)
      .json({ error: "Push notifications not configured on server" });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Save a browser's push subscription
app.post("/api/push/subscribe", requireAuth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys)
      return res.status(400).json({ error: "Invalid subscription object" });

    await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: { userId: req.userId, keys: JSON.stringify(keys) },
      create: {
        userId: req.userId,
        endpoint,
        keys: JSON.stringify(keys),
        userAgent: req.headers["user-agent"] || null,
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Error saving push subscription:", error);
    res.status(500).json({ error: error.message });
  }
});

// Remove a subscription (e.g. user disables notifications)
app.post("/api/push/unsubscribe", requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: "Endpoint required" });
    await prisma.pushSubscription.deleteMany({
      where: { endpoint, userId: req.userId },
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send a test push to the logged-in user's own devices
app.post("/api/push/test", requireAuth, async (req, res) => {
  if (!pushEnabled)
    return res.status(500).json({ error: "Push not configured" });
  try {
    const subs = await prisma.pushSubscription.findMany({
      where: { userId: req.userId },
    });
    if (subs.length === 0)
      return res
        .status(400)
        .json({ error: "No subscriptions found for this account" });

    const payload = JSON.stringify({
      title: "SmartPantry",
      body: "Test notification — push is working!",
    });

    let sent = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: JSON.parse(sub.keys) },
          payload,
        );
        sent++;
      } catch (err) {
        // If the subscription is no longer valid, remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          await prisma.pushSubscription
            .delete({ where: { id: sub.id } })
            .catch(() => {});
        }
      }
    }
    res.json({ success: true, sent });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Core function: check every user's pantry and push alerts for items expiring within 3 days.
// Called by the daily cron job below, and also exposed as a manual trigger route.
async function sendExpiryPushNotifications() {
  if (!pushEnabled) {
    console.warn("Skipping push run — VAPID keys not configured");
    return { usersNotified: 0 };
  }

  const today = new Date();
  const threeDays = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);

  const users = await prisma.user.findMany({
    include: {
      pantryItems: true,
      pushSubscriptions: true,
    },
  });

  let usersNotified = 0;

  for (const user of users) {
    if (user.pushSubscriptions.length === 0) continue;

    const expiringSoon = user.pantryItems.filter(
      (item) => new Date(item.expirationDate) <= threeDays,
    );
    if (expiringSoon.length === 0) continue;

    const body =
      expiringSoon.length === 1
        ? `${expiringSoon[0].name} is expiring soon`
        : `${expiringSoon.length} items are expiring soon`;

    const payload = JSON.stringify({ title: "SmartPantry", body, url: "/" });

    for (const sub of user.pushSubscriptions) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: JSON.parse(sub.keys) },
          payload,
        );
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await prisma.pushSubscription
            .delete({ where: { id: sub.id } })
            .catch(() => {});
        }
      }
    }
    usersNotified++;
  }

  console.log(`Expiry push run complete — notified ${usersNotified} user(s)`);
  return { usersNotified };
}

// Manual trigger (useful for testing without waiting for the cron schedule)
app.post("/api/push/run-expiry-check", requireAuth, async (req, res) => {
  try {
    const result = await sendExpiryPushNotifications();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// External cron trigger — no user login required, protected by a shared secret instead.
app.post("/api/push/cron-trigger", async (req, res) => {
  const providedSecret = req.headers["x-cron-secret"] || req.query.secret;

  if (!process.env.CRON_SECRET) {
    return res
      .status(500)
      .json({ error: "CRON_SECRET not configured on server" });
  }
  if (providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Invalid or missing cron secret" });
  }

  try {
    console.log("Running expiry push check via external cron trigger...");
    const result = await sendExpiryPushNotifications();
    res.json(result);
  } catch (error) {
    console.error("Cron trigger push job failed:", error);
    res.status(500).json({ error: error.message });
  }
});

// Runs automatically every day at 8:00 AM server time
cron.schedule("0 8 * * *", () => {
  console.log("Running daily expiry push check...");
  sendExpiryPushNotifications().catch((err) =>
    console.error("Expiry push job failed:", err),
  );
});

// ============ HEALTH CHECK ============

app.get("/api/health", async (req, res) => {
  try {
    await prisma.user.count();
    res.json({ status: "ok", database: "connected", pushEnabled });
  } catch (error) {
    res.status(500).json({
      status: "error",
      database: "disconnected",
      error: error.message,
    });
  }
});

// Serve frontend for all other routes using native RegExp fallback
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "File too large (max 10 MB)"
        : err.message;
    return res.status(400).json({ error: message });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ============ START ============

const server = app.listen(PORT, async () => {
  console.log(`\n✅ SmartPantry running at http://localhost:${PORT}`);
});

server.on("error", (err) => console.error("Server error:", err));

process.on("uncaughtException", (err) =>
  console.error("Uncaught exception:", err),
);
process.on("unhandledRejection", (reason) =>
  console.error("Unhandled rejection:", reason),
);

process.on("SIGINT", async () => {
  console.log("\nShutting down gracefully...");
  await prisma.$disconnect();
  process.exit(0);
});
