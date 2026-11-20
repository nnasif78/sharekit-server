
import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";
import { jwtVerify } from "jose";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";

const app = express();
const PORT = process.env.PORT || 5000;

const client = new MongoClient(process.env.MONGODB_URI);

let db;
let auth;
let equipmentCollection;
let rentalsCollection;
let usersCollection;
let reservationsCollection;
let paymentsCollection;

const getStripe = () => {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Stripe is not configured");
  return new Stripe(process.env.STRIPE_SECRET_KEY);
};

const periodDays = (rentalType) => rentalType === "weekly" ? 7 : rentalType === "monthly" ? 30 : 1;
const equipmentSlug = (name) => name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "equipment";
let completionJobRunning = false;

const sendNotification = async ({ to, subject, text }) => {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    console.warn(`Email notification skipped for ${to}: configure RESEND_API_KEY and EMAIL_FROM`);
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text }),
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Email delivery failed (${response.status}): ${details}`);
  }
};

const notifyRental = async (recipients, subject, text) => {
  const results = await Promise.allSettled(
    [...new Set(recipients.filter((email) => typeof email === "string" && email))].map((to) =>
      sendNotification({ to, subject, text })
    )
  );
  for (const result of results) {
    if (result.status === "rejected") console.error("Rental notification error:", result.reason);
  }
};

const releaseReservation = async (reservationId, status) => {
  if (!ObjectId.isValid(reservationId)) return;
  const result = await reservationsCollection.updateOne(
    { _id: new ObjectId(reservationId), status: "pending", inventoryReleased: { $ne: true } },
    { $set: { status, inventoryReleased: true, updatedAt: new Date() } }
  );
  if (result.modifiedCount) {
    const reservation = await reservationsCollection.findOne({ _id: new ObjectId(reservationId) });
    if (reservation) await equipmentCollection.updateOne({ _id: reservation.equipmentId }, { $inc: { availableQuantity: reservation.quantity } });
  }
};

const fulfillCheckout = async (checkoutSession) => {
  const reservationId = checkoutSession.metadata?.reservationId;
  if (!ObjectId.isValid(reservationId) || checkoutSession.payment_status !== "paid") return;
  const reservation = await reservationsCollection.findOne({ _id: new ObjectId(reservationId) });
  if (!reservation || reservation.status === "cancelled" || reservation.status === "expired") return;
  if (checkoutSession.amount_total !== reservation.amountMinor || checkoutSession.currency !== reservation.currency) {
    console.error("Stripe checkout amount mismatch", checkoutSession.id);
    return;
  }

  const rental = {
    checkoutSessionId: checkoutSession.id,
    reservationId: reservation._id.toString(),
    customerId: reservation.customerId,
    customerName: reservation.customerName,
    customerEmail: reservation.customerEmail,
    ownerId: reservation.ownerId,
    ownerName: reservation.ownerName,
    ownerEmail: reservation.ownerEmail,
    equipmentId: reservation.equipmentId,
    equipmentName: reservation.equipmentName,
    startDate: reservation.startDate,
    endDate: reservation.endDate,
    rentalDays: reservation.rentalDays,
    billableUnits: reservation.billableUnits,
    quantity: reservation.quantity,
    requiredQuantity: reservation.quantity,
    contactNumber: reservation.contactNumber,
    deliveryAddress: reservation.deliveryAddress,
    additionalNotes: reservation.additionalNotes,
    bookingAmount: reservation.totalAmount,
    totalAmount: reservation.totalAmount,
    currency: reservation.currency,
    paymentStatus: "paid",
    paymentIntentId: typeof checkoutSession.payment_intent === "string" ? checkoutSession.payment_intent : checkoutSession.payment_intent?.id,
    status: "pending",
    bookingStatus: "pending",
    createdAt: reservation.createdAt,
    updatedAt: new Date(),
  };
  const rentalResult = await rentalsCollection.updateOne({ checkoutSessionId: checkoutSession.id }, { $setOnInsert: rental }, { upsert: true });
  await paymentsCollection.updateOne({ stripeSessionId: checkoutSession.id }, { $setOnInsert: {
    stripeSessionId: checkoutSession.id,
    paymentIntentId: rental.paymentIntentId,
    reservationId: reservation._id.toString(),
    customerId: reservation.customerId,
    equipmentId: reservation.equipmentId,
    amount: reservation.totalAmount,
    amountMinor: checkoutSession.amount_total,
    currency: checkoutSession.currency,
    status: "paid",
    transactionDetails: {
      checkoutSessionId: checkoutSession.id,
      paymentIntentId: rental.paymentIntentId,
      customerEmail: reservation.customerEmail,
      amount: reservation.totalAmount,
      currency: reservation.currency,
      paymentStatus: "paid",
    },
    createdAt: new Date(),
  } }, { upsert: true });
  await reservationsCollection.updateOne({ _id: reservation._id, status: "pending" }, { $set: { status: "paid", paymentStatus: "paid", paymentIntentId: rental.paymentIntentId, updatedAt: new Date() } });
  if (rentalResult.upsertedCount) {
    await notifyRental(
      [reservation.customerEmail, reservation.ownerEmail],
      `Rental booked: ${reservation.equipmentName}`,
      `Payment is confirmed for ${reservation.equipmentName}. Rental dates: ${reservation.startDate} to ${reservation.endDate}.`
    );
  }
};

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);

// Stripe requires the unparsed request bytes to verify webhook signatures.
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    if (!process.env.STRIPE_WEBHOOK_SECRET) return res.status(500).send("Webhook is not configured");
    event = getStripe().webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error("Stripe webhook signature error:", error.message);
    return res.status(400).send("Invalid Stripe webhook signature");
  }
  try {
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      await fulfillCheckout(event.data.object);
    } else if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
      await releaseReservation(event.data.object.metadata?.reservationId, "expired");
    }
    res.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook processing error:", error);
    res.status(500).json({ received: false });
  }
});

app.use(express.json());

app.get("/", (req, res) => {
  res.send("ShareKit API is running!");
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "ShareKit API is healthy",
    database: db ? "Connected" : "Disconnected",
  });
});

// Authentication middleware
const verifyToken = async (req, res, next) => {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) {
    return res.status(401).json({ success: false, message: "A valid access token is required" });
  }
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    console.error("JWT authentication configuration error: BETTER_AUTH_SECRET is not configured");
    return res.status(500).json({ success: false, message: "Authentication is not configured" });
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] }));
  } catch {
    return res.status(401).json({ success: false, message: "Access token is invalid or expired" });
  }

  if (typeof payload.sub !== "string") {
    return res.status(401).json({ success: false, message: "Access token is invalid" });
  }

  const account = await usersCollection.findOne(userIdQuery(payload.sub), {
    projection: { disabled: 1, role: 1, name: 1, email: 1 },
  });
  if (!account) return res.status(401).json({ success: false, message: "Account not found" });
  if (account.disabled) return res.status(403).json({ success: false, message: "This account is disabled" });

  req.user = {
    id: payload.sub,
    name: account.name || "",
    email: account.email || "",
    role: account.role || payload.role || "customer",
  };
  next();
};

const verifyRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to perform this action",
      });
    }

    next();
  };
};
const verifyRenter = verifyRole("customer");
const verifyOwner = verifyRole("owner");
const verifyAdmin = verifyRole("admin");

// Escape user input before using regular expressions
const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const userIdQuery = (id) => ({
  $or: [
    { _id: id },
    ...(ObjectId.isValid(id) ? [{ _id: new ObjectId(id) }] : []),
  ],
});

// PUBLIC: Get approved equipment
app.get("/api/equipment", async (req, res) => {
  try {
    const {
      search,
      category,
      rentalType,
      minPrice,
      maxPrice,
      availability,
      sort,
      page = "1",
      pageSize = "9",
    } = req.query;
    const pageNumber = Number(page);
    const requestedPageSize = Number(pageSize);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || !Number.isInteger(requestedPageSize) || requestedPageSize < 1) {
      return res.status(400).json({ success: false, message: "Page and page size must be positive whole numbers" });
    }
    const limit = Math.min(requestedPageSize, 48);

    const query = { status: "approved" };

    if (search && typeof search === "string") {
      const searchRegex = {
        $regex: escapeRegex(search.trim()),
        $options: "i",
      };

      query.$or = [
        { name: searchRegex },
        { location: searchRegex },
      ];
    }

    if (category) query.category = category;
    if (rentalType) query.rentalType = rentalType;

    if (minPrice || maxPrice) {
      const min = Number(minPrice);
      const max = Number(maxPrice);

      if (
        (minPrice && (!Number.isFinite(min) || min < 0)) ||
        (maxPrice && (!Number.isFinite(max) || max < 0)) ||
        (minPrice && maxPrice && min > max)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid price range",
        });
      }

      query.price = {};

      if (minPrice) query.price.$gte = min;
      if (maxPrice) query.price.$lte = max;
    }

    if (availability === "available") {
      query.availableQuantity = { $gt: 0 };
    } else if (availability === "unavailable") {
      query.availableQuantity = { $lte: 0 };
    }

    let sortOption = { createdAt: -1 };

    if (sort === "price_asc") {
      sortOption = { price: 1 };
    } else if (sort === "price_desc") {
      sortOption = { price: -1 };
    }

    const [equipment, totalCount] = await Promise.all([
      equipmentCollection.find(query).sort(sortOption).skip((pageNumber - 1) * limit).limit(limit).toArray(),
      equipmentCollection.countDocuments(query),
    ]);

    res.json({
      success: true,
      count: totalCount,
      pagination: { page: pageNumber, pageSize: limit, totalPages: Math.ceil(totalCount / limit) },
      data: equipment,
    });
  } catch (error) {
    console.error("Equipment fetch error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch equipment",
    });
  }
});

app.get("/api/equipment/by-name/:name", async (req, res) => {
  try {
    const name = req.params.name.toLowerCase();
    let equipment = await equipmentCollection.find({ status: "approved", slug: name }).sort({ createdAt: -1 }).limit(1).next();
    if (!equipment) {
      const approved = await equipmentCollection.find({ status: "approved" }).sort({ createdAt: -1 }).toArray();
      equipment = approved.find((item) => equipmentSlug(item.name) === name);
    }
    if (!equipment) return res.status(404).json({ success: false, message: "Equipment not found" });
    res.json({ success: true, data: { ...equipment, _id: equipment._id.toString() } });
  } catch (error) {
    console.error("Equipment detail fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch equipment details" });
  }
});

app.get("/api/equipment/:id", async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid equipment ID" });
    const equipment = await equipmentCollection.findOne({ _id: new ObjectId(req.params.id), status: "approved" });
    if (!equipment) return res.status(404).json({ success: false, message: "Equipment not found" });
    res.json({ success: true, data: { ...equipment, _id: equipment._id.toString() } });
  } catch (error) {
    console.error("Equipment detail fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch equipment details" });
  }
});

// OWNER: Add equipment
app.post(
  "/api/equipment",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const {
        name,
        description,
        category,
        location,
        price,
        rentalType,
        availableQuantity,
        condition,
        brand,
        model,
        image,
        rentalTerms,
      } = req.body;

      if (
        !name?.trim() ||
        !description?.trim() ||
        !category ||
        !location?.trim() ||
        price === undefined ||
        !rentalType ||
        availableQuantity === undefined ||
        !condition ||
        !image ||
        typeof image !== "string"
      ) {
        return res.status(400).json({
          success: false,
          message: "Please provide all required equipment information",
        });
      }

      if (
        typeof price !== "number" ||
        !Number.isFinite(price) ||
        price <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Price must be a positive number",
        });
      }

      if (
        !Number.isInteger(availableQuantity) ||
        availableQuantity <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Available quantity must be a positive integer",
        });
      }

      if (!["daily", "weekly", "monthly"].includes(rentalType)) {
        return res.status(400).json({
          success: false,
          message: "Invalid rental type",
        });
      }

      const equipment = {
        name: name.trim(),
        slug: equipmentSlug(name),
        description: description.trim(),
        category,
        location: location.trim(),
        price,
        rentalType,
        availableQuantity,
        condition,
        brand: brand || "",
        model: model || "",
        image,
        rentalTerms: rentalTerms || "",
        ownerId: req.user.id,
        ownerName: req.user.name,
        ownerEmail: req.user.email,
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await equipmentCollection.insertOne(equipment);

      res.status(201).json({
        success: true,
        message: "Equipment submitted for admin approval",
        data: {
          _id: result.insertedId,
          ...equipment,
        },
      });
    } catch (error) {
      console.error("Equipment creation error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to add equipment",
      });
    }
  }
);

// OWNER: Get own equipment
app.get(
  "/api/my-equipment",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const equipment = await equipmentCollection
        .find({ ownerId: req.user.id })
        .sort({ createdAt: -1 })
        .toArray();

      res.json({
        success: true,
        count: equipment.length,
        data: equipment,
      });
    } catch (error) {
      console.error("My equipment error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch your equipment",
      });
    }
  }
);

// OWNER: Get rentals for this owner's equipment
app.get(
  "/api/owner/rentals",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const equipment = await equipmentCollection
        .find({ ownerId: req.user.id })
        .project({ _id: 1, name: 1 })
        .toArray();
      const equipmentById = new Map(equipment.map((item) => [item._id.toString(), item]));
      const ids = equipment.map((item) => item._id);
      const idStrings = ids.map((id) => id.toString());

      if (!ids.length) {
        return res.json({ success: true, count: 0, data: [] });
      }

      const rentals = await rentalsCollection
        .find({ $or: [{ equipmentId: { $in: ids } }, { equipmentId: { $in: idStrings } }] })
        .sort({ createdAt: -1 })
        .toArray();

      const data = rentals.map((rental) => {
        const linkedEquipment = equipmentById.get(String(rental.equipmentId));
        return {
          ...rental,
          _id: rental._id.toString(),
          equipmentName: rental.equipmentName || rental.itemName || linkedEquipment?.name || "Equipment",
          customerName: rental.customerName || rental.userName || rental.customer?.name || rental.user?.name || "Customer",
          customerEmail: rental.customerEmail || rental.userEmail || rental.customer?.email || rental.user?.email || "",
          duration: rental.duration || rental.rentalDuration || "",
          quantity: rental.quantity ?? rental.requiredQuantity,
          bookingAmount: rental.bookingAmount ?? rental.totalAmount ?? rental.amount,
          paymentStatus: rental.paymentStatus || rental.payment?.status || "Pending",
          status: rental.status || rental.bookingStatus || "Pending",
        };
      });

      res.json({ success: true, count: data.length, data });
    } catch (error) {
      console.error("Owner rentals fetch error:", error);
      res.status(500).json({ success: false, message: "Failed to fetch your equipment rentals" });
    }
  }
);

app.get("/api/owner/analytics", verifyToken, verifyOwner, async (req, res) => {
  try {
    const equipment = await equipmentCollection.find({ ownerId: req.user.id }, { projection: { _id: 1 } }).toArray();
    const equipmentIds = equipment.map((item) => item._id);
    const equipmentIdStrings = equipmentIds.map(String);
    const rentals = equipmentIds.length
      ? await rentalsCollection.find({ $or: [
        { equipmentId: { $in: equipmentIds } },
        { equipmentId: { $in: equipmentIdStrings } },
      ] }).toArray()
      : [];
    const completed = rentals.filter((rental) => String(rental.status || rental.bookingStatus || "").toLowerCase() === "completed");
    const monthlyEarnings = Array.from({ length: 12 }, (_, index) => {
      const month = new Date();
      month.setDate(1);
      month.setHours(0, 0, 0, 0);
      month.setMonth(month.getMonth() - (11 - index));
      const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
      const earnings = completed.reduce((sum, rental) => {
        const amount = Number(rental.totalAmount ?? rental.bookingAmount ?? rental.amount ?? 0);
        const recordedAt = rental.completedAt || rental.endDate || rental.updatedAt || rental.createdAt;
        const date = recordedAt ? new Date(recordedAt) : null;
        return date && `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}` === key
          ? sum + (Number.isFinite(amount) ? amount : 0)
          : sum;
      }, 0);
      return { month: key, earnings: Number(earnings.toFixed(2)) };
    });
    res.json({
      success: true,
      data: {
        listedEquipment: equipment.length,
        completedRentals: completed.length,
        earnings: Number(completed.reduce((sum, rental) => sum + Number(rental.totalAmount ?? rental.bookingAmount ?? rental.amount ?? 0), 0).toFixed(2)),
        monthlyEarnings,
      },
    });
  } catch (error) {
    console.error("Owner analytics error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch owner analytics" });
  }
});

// OWNER: Update own equipment
app.patch(
  "/api/equipment/:id",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid equipment ID",
        });
      }

      const allowedFields = [
        "name",
        "description",
        "category",
        "location",
        "price",
        "rentalType",
        "availableQuantity",
        "condition",
        "brand",
        "model",
        "image",
        "rentalTerms",
      ];

      const updateData = {};

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updateData[field] = req.body[field];
        }
      }

      if (updateData.name !== undefined && typeof updateData.name === "string") {
        updateData.slug = equipmentSlug(updateData.name);
      }

      if (!Object.keys(updateData).length) {
        return res.status(400).json({
          success: false,
          message: "No valid fields provided",
        });
      }

      if (
        updateData.price !== undefined &&
        (typeof updateData.price !== "number" ||
          !Number.isFinite(updateData.price) ||
          updateData.price <= 0)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid equipment price",
        });
      }

      if (
        updateData.availableQuantity !== undefined &&
        (!Number.isInteger(updateData.availableQuantity) ||
          updateData.availableQuantity < 0)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid available quantity",
        });
      }

      if (
        updateData.rentalType !== undefined &&
        !["daily", "weekly", "monthly"].includes(updateData.rentalType)
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid rental type",
        });
      }

      updateData.updatedAt = new Date();
      updateData.status = "pending";

      const result = await equipmentCollection.updateOne(
        {
          _id: new ObjectId(id),
          ownerId: req.user.id,
        },
        {
          $set: updateData,
        }
      );

      if (!result.matchedCount) {
        return res.status(404).json({
          success: false,
          message: "Equipment not found",
        });
      }

      res.json({
        success: true,
        message: "Equipment updated and submitted for approval",
      });
    } catch (error) {
      console.error("Equipment update error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to update equipment",
      });
    }
  }
);

// OWNER: Delete own equipment
app.delete(
  "/api/equipment/:id",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid equipment ID",
        });
      }

      const result = await equipmentCollection.deleteOne({
        _id: new ObjectId(id),
        ownerId: req.user.id,
      });

      if (!result.deletedCount) {
        return res.status(404).json({
          success: false,
          message: "Equipment not found",
        });
      }

      res.json({
        success: true,
        message: "Equipment deleted successfully",
      });
    } catch (error) {
      console.error("Equipment deletion error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to delete equipment",
      });
    }
  }
);

// ADMIN: Get all equipment
app.get(
  "/api/admin/equipment",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { status } = req.query;
      const query = {};

      if (status) {
        if (!["pending", "approved", "rejected"].includes(status)) {
          return res.status(400).json({
            success: false,
            message: "Invalid equipment status",
          });
        }

        query.status = status;
      }

      const equipment = await equipmentCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.json({
        success: true,
        count: equipment.length,
        data: equipment,
      });
    } catch (error) {
      console.error("Admin equipment fetch error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch equipment",
      });
    }
  }
);

// ADMIN: Approve or reject equipment
app.patch(
  "/api/admin/equipment/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid equipment ID",
        });
      }

      if (!["approved", "rejected"].includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Status must be approved or rejected",
        });
      }

      const result = await equipmentCollection.updateOne(
        {
          _id: new ObjectId(id),
          status: "pending",
        },
        {
          $set: {
            status,
            reviewedBy: req.user.id,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          },
        }
      );

      if (!result.matchedCount) {
        return res.status(404).json({
          success: false,
          message: "Pending equipment not found",
        });
      }

      res.json({
        success: true,
        message: `Equipment ${status} successfully`,
      });
    } catch (error) {
      console.error("Equipment approval error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to update equipment status",
      });
    }
  }
);

// ADMIN: Manage registered users
app.get("/api/admin/analytics", verifyToken, verifyAdmin, async (_req, res) => {
  try {
    const [users, equipment, rentals, payments] = await Promise.all([
      usersCollection.find({}, { projection: { _id: 1 } }).toArray(),
      equipmentCollection.find({}, { projection: { _id: 1, status: 1 } }).toArray(),
      rentalsCollection.find({}, { projection: { status: 1, bookingStatus: 1, createdAt: 1 } }).toArray(),
      paymentsCollection.find({ status: "paid" }, { projection: { amount: 1, createdAt: 1 } }).toArray(),
    ]);
    const monthlyBookings = Array.from({ length: 12 }, (_, index) => {
      const month = new Date();
      month.setDate(1);
      month.setHours(0, 0, 0, 0);
      month.setMonth(month.getMonth() - (11 - index));
      const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
      return {
        month: key,
        bookings: rentals.filter((rental) => {
          const date = rental.createdAt ? new Date(rental.createdAt) : null;
          return date && `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}` === key;
        }).length,
      };
    });
    const revenue = payments.reduce((sum, payment) => {
      const amount = Number(payment.amount || 0);
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);
    res.json({
      success: true,
      data: {
        users: users.length,
        equipment: equipment.length,
        bookings: rentals.length,
        pendingApprovals: equipment.filter((item) => String(item.status || "").toLowerCase() === "pending").length,
        completedRentals: rentals.filter((rental) => String(rental.status || rental.bookingStatus || "").toLowerCase() === "completed").length,
        revenue: Number(revenue.toFixed(2)),
        monthlyBookings,
      },
    });
  } catch (error) {
    console.error("Admin analytics error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch admin analytics" });
  }
});

app.get("/api/admin/users", verifyToken, verifyAdmin, async (_req, res) => {
  try {
    const users = await usersCollection
      .find({}, { projection: { name: 1, email: 1, role: 1, createdAt: 1, disabled: 1, emailVerified: 1 } })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ success: true, count: users.length, data: users.map((user) => ({
      _id: user._id.toString(), name: user.name, email: user.email,
      role: user.role || "customer", createdAt: user.createdAt,
      disabled: Boolean(user.disabled), emailVerified: Boolean(user.emailVerified),
    })) });
  } catch (error) {
    console.error("Admin users fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch users" });
  }
});

app.patch("/api/admin/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    if (!["customer", "owner", "admin"].includes(role)) return res.status(400).json({ success: false, message: "Role must be customer, owner, or admin" });
    if (id === req.user.id && role !== "admin") return res.status(400).json({ success: false, message: "You cannot remove your own admin role" });
    const result = await usersCollection.updateOne(userIdQuery(id), { $set: { role, updatedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ success: false, message: "User not found" });
    res.json({ success: true, message: "User role updated" });
  } catch (error) {
    console.error("Admin user role update error:", error);
    res.status(500).json({ success: false, message: "Failed to update user role" });
  }
});

app.patch("/api/admin/users/:id/access", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { disabled } = req.body;
    if (typeof disabled !== "boolean") return res.status(400).json({ success: false, message: "disabled must be a boolean" });
    if (id === req.user.id && disabled) return res.status(400).json({ success: false, message: "You cannot disable your own account" });
    const result = await usersCollection.updateOne(userIdQuery(id), { $set: { disabled, updatedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ success: false, message: "User not found" });
    res.json({ success: true, message: disabled ? "User access disabled" : "User access restored" });
  } catch (error) {
    console.error("Admin user access update error:", error);
    res.status(500).json({ success: false, message: "Failed to update user access" });
  }
});

// ADMIN: Edit and remove equipment listings
app.patch("/api/admin/equipment/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid equipment ID" });
    const allowed = ["name", "description", "category", "location", "price", "rentalType", "availableQuantity", "condition", "brand", "model", "image", "rentalTerms"];
    const updateData = Object.fromEntries(allowed.filter((field) => req.body[field] !== undefined).map((field) => [field, req.body[field]]));
    if (!Object.keys(updateData).length) return res.status(400).json({ success: false, message: "No valid fields provided" });
    if (updateData.name !== undefined && typeof updateData.name === "string") updateData.slug = equipmentSlug(updateData.name);
    if (updateData.price !== undefined && (typeof updateData.price !== "number" || !Number.isFinite(updateData.price) || updateData.price <= 0)) return res.status(400).json({ success: false, message: "Invalid equipment price" });
    if (updateData.availableQuantity !== undefined && (!Number.isInteger(updateData.availableQuantity) || updateData.availableQuantity < 0)) return res.status(400).json({ success: false, message: "Invalid available quantity" });
    if (updateData.rentalType !== undefined && !["daily", "weekly", "monthly"].includes(updateData.rentalType)) return res.status(400).json({ success: false, message: "Invalid rental type" });
    updateData.updatedAt = new Date();
    const result = await equipmentCollection.updateOne({ _id: new ObjectId(id) }, { $set: updateData });
    if (!result.matchedCount) return res.status(404).json({ success: false, message: "Equipment not found" });
    res.json({ success: true, message: "Equipment updated" });
  } catch (error) {
    console.error("Admin equipment update error:", error);
    res.status(500).json({ success: false, message: "Failed to update equipment" });
  }
});

app.delete("/api/admin/equipment/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid equipment ID" });
    const result = await equipmentCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    if (!result.deletedCount) return res.status(404).json({ success: false, message: "Equipment not found" });
    res.json({ success: true, message: "Equipment deleted" });
  } catch (error) {
    console.error("Admin equipment deletion error:", error);
    res.status(500).json({ success: false, message: "Failed to delete equipment" });
  }
});

// ADMIN: Monitor and update rental bookings
app.get("/api/admin/rentals", verifyToken, verifyAdmin, async (_req, res) => {
  try {
    const [rentals, equipment, users] = await Promise.all([
      rentalsCollection.find({}).sort({ createdAt: -1 }).toArray(),
      equipmentCollection.find({}, { projection: { name: 1, ownerId: 1, ownerName: 1, ownerEmail: 1 } }).toArray(),
      usersCollection.find({}, { projection: { name: 1, email: 1 } }).toArray(),
    ]);
    const equipmentById = new Map(equipment.map((item) => [item._id.toString(), item]));
    const usersById = new Map(users.map((user) => [user._id.toString(), user]));
    const data = rentals.map((rental) => {
      const linked = equipmentById.get(String(rental.equipmentId));
      const customer = usersById.get(String(rental.customerId || rental.userId));
      const owner = usersById.get(String(linked?.ownerId || rental.ownerId));
      return {
        ...rental, _id: rental._id.toString(),
        customerName: rental.customerName || rental.userName || rental.customer?.name || customer?.name || "Customer",
        customerEmail: rental.customerEmail || rental.userEmail || rental.customer?.email || customer?.email || "",
        ownerName: rental.ownerName || linked?.ownerName || owner?.name || "Owner",
        ownerEmail: rental.ownerEmail || linked?.ownerEmail || owner?.email || "",
        equipmentName: rental.equipmentName || rental.itemName || linked?.name || "Equipment",
        duration: rental.duration || rental.rentalDuration || "",
        bookingAmount: rental.bookingAmount ?? rental.totalAmount ?? rental.amount,
        paymentStatus: rental.paymentStatus || rental.payment?.status || "Pending",
        status: rental.status || rental.bookingStatus || "Pending",
      };
    });
    res.json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("Admin rentals fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch rentals" });
  }
});

app.patch("/api/admin/rentals/:id/status", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid rental ID" });
    if (!["pending", "approved", "rejected", "cancelled", "completed"].includes(status)) return res.status(400).json({ success: false, message: "Invalid booking status" });
    const rental = await rentalsCollection.findOne({ _id: new ObjectId(id) });
    if (!rental) return res.status(404).json({ success: false, message: "Rental not found" });
    const terminalStatuses = ["rejected", "cancelled", "completed"];
    if (terminalStatuses.includes(rental.status) && status !== rental.status) return res.status(409).json({ success: false, message: "A closed rental cannot be reopened" });
    const shouldRelease = terminalStatuses.includes(status) && !rental.inventoryReleased;
    const result = await rentalsCollection.updateOne(
      { _id: rental._id, status: rental.status, ...(shouldRelease ? { inventoryReleased: { $ne: true } } : {}) },
      { $set: {
        status,
        bookingStatus: status,
        ...(status === "completed" ? { completedAt: new Date() } : {}),
        ...(shouldRelease ? { inventoryReleased: true } : {}),
        updatedAt: new Date(),
      } }
    );
    if (!result.matchedCount) return res.status(409).json({ success: false, message: "Rental status changed. Refresh and try again." });
    if (shouldRelease) await equipmentCollection.updateOne({ _id: rental.equipmentId }, { $inc: { availableQuantity: rental.quantity || rental.requiredQuantity || 0 } });
    if (rental.status !== status) {
      await notifyRental(
        [rental.customerEmail, rental.ownerEmail],
        `Rental status updated: ${rental.equipmentName || "equipment"}`,
        `The booking for ${rental.equipmentName || "your equipment"} is now ${status}.`
      );
    }
    res.json({ success: true, message: "Rental status updated" });
  } catch (error) {
    console.error("Admin rental status update error:", error);
    res.status(500).json({ success: false, message: "Failed to update rental status" });
  }
});

// Any signed-in user: read and update their own profile
app.get("/api/profile", verifyToken, async (req, res) => {
  try {
    const user = await usersCollection.findOne(userIdQuery(req.user.id), {
      projection: { name: 1, email: 1, image: 1, phoneNumber: 1, address: 1, role: 1 },
    });
    if (!user) return res.status(404).json({ success: false, message: "Profile not found" });
    res.json({ success: true, data: { name: user.name || "", email: user.email || "", image: user.image || "", phoneNumber: user.phoneNumber || "", address: user.address || "", role: user.role || "customer" } });
  } catch (error) {
    console.error("Profile fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to load profile" });
  }
});

app.patch("/api/profile", verifyToken, async (req, res) => {
  try {
    const allowed = ["name", "image", "phoneNumber", "address"];
    const changes = Object.fromEntries(allowed.filter((field) => req.body[field] !== undefined).map((field) => [field, req.body[field]]));
    if (!Object.keys(changes).length) return res.status(400).json({ success: false, message: "No profile fields provided" });
    for (const [field, value] of Object.entries(changes)) {
      if (typeof value !== "string") return res.status(400).json({ success: false, message: `${field} must be text` });
      changes[field] = value.trim();
    }
    if (changes.name !== undefined && !changes.name) return res.status(400).json({ success: false, message: "Name cannot be empty" });
    if ((changes.name?.length || 0) > 120 || (changes.phoneNumber?.length || 0) > 40 || (changes.address?.length || 0) > 500 || (changes.image?.length || 0) > 2048) return res.status(400).json({ success: false, message: "Profile field is too long" });
    changes.updatedAt = new Date();
    const result = await usersCollection.updateOne(userIdQuery(req.user.id), { $set: changes });
    if (!result.matchedCount) return res.status(404).json({ success: false, message: "Profile not found" });
    res.json({ success: true, message: "Profile updated" });
  } catch (error) {
    console.error("Profile update error:", error);
    res.status(500).json({ success: false, message: "Failed to update profile" });
  }
});

// CUSTOMER: their own rental bookings
app.get("/api/customer/rentals", verifyToken, verifyRenter, async (req, res) => {
  try {
    const customerIds = [req.user.id, ...(ObjectId.isValid(req.user.id) ? [new ObjectId(req.user.id)] : [])];
    const rentals = await rentalsCollection.find({ $or: [
      { customerId: { $in: customerIds } }, { userId: { $in: customerIds } },
      { "customer.id": { $in: customerIds } }, { "user.id": { $in: customerIds } },
      { customerEmail: req.user.email }, { userEmail: req.user.email },
      { "customer.email": req.user.email }, { "user.email": req.user.email },
    ] }).sort({ createdAt: -1 }).toArray();
    const equipmentIds = [...new Set(rentals.map((rental) => String(rental.equipmentId || "")).filter(Boolean))];
    const objectIds = equipmentIds.filter(ObjectId.isValid).map((id) => new ObjectId(id));
    const equipment = await equipmentCollection.find({ _id: { $in: objectIds } }, { projection: { name: 1 } }).toArray();
    const equipmentById = new Map(equipment.map((item) => [item._id.toString(), item.name]));
    const data = rentals.map((rental) => ({
      ...rental, _id: rental._id.toString(),
      equipmentName: rental.equipmentName || rental.itemName || equipmentById.get(String(rental.equipmentId)) || "Equipment",
      startDate: rental.startDate || rental.rentalStartDate || "",
      endDate: rental.endDate || rental.rentalEndDate || "",
      bookingDate: rental.bookingDate || rental.createdAt || "",
      totalAmount: rental.totalAmount ?? rental.bookingAmount ?? rental.amount,
      paymentStatus: rental.paymentStatus || rental.payment?.status || "Pending",
      status: rental.status || rental.bookingStatus || "Pending",
    }));
    res.json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("Customer rentals fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch your rentals" });
  }
});

// CUSTOMER: manage their own favorites
app.get("/api/customer/favorites", verifyToken, verifyRenter, async (req, res) => {
  try {
    const user = await usersCollection.findOne(userIdQuery(req.user.id), { projection: { favorites: 1 } });
    const ids = (user?.favorites || []).map(String);
    const equipment = await equipmentCollection.find({ status: "approved", _id: { $in: ids.filter(ObjectId.isValid).map((id) => new ObjectId(id)) } }).sort({ createdAt: -1 }).toArray();
    res.json({ success: true, count: equipment.length, data: equipment });
  } catch (error) {
    console.error("Customer favorites fetch error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch favorites" });
  }
});

app.post("/api/customer/favorites/:equipmentId", verifyToken, verifyRenter, async (req, res) => {
  try {
    const { equipmentId } = req.params;
    if (!ObjectId.isValid(equipmentId)) return res.status(400).json({ success: false, message: "Invalid equipment ID" });
    const equipment = await equipmentCollection.findOne({ _id: new ObjectId(equipmentId), status: "approved" }, { projection: { _id: 1 } });
    if (!equipment) return res.status(404).json({ success: false, message: "Approved equipment not found" });
    await usersCollection.updateOne(userIdQuery(req.user.id), { $addToSet: { favorites: equipmentId } });
    res.json({ success: true, message: "Added to favorites" });
  } catch (error) {
    console.error("Customer favorite add error:", error);
    res.status(500).json({ success: false, message: "Failed to add favorite" });
  }
});

app.delete("/api/customer/favorites/:equipmentId", verifyToken, verifyRenter, async (req, res) => {
  try {
    const { equipmentId } = req.params;
    if (!ObjectId.isValid(equipmentId)) return res.status(400).json({ success: false, message: "Invalid equipment ID" });
    await usersCollection.updateOne(userIdQuery(req.user.id), { $pull: { favorites: equipmentId } });
    res.json({ success: true, message: "Removed from favorites" });
  } catch (error) {
    console.error("Customer favorite removal error:", error);
    res.status(500).json({ success: false, message: "Failed to remove favorite" });
  }
});

// CUSTOMER: reserve available quantity and create a hosted Stripe Checkout Session
app.post("/api/customer/equipment/:equipmentId/checkout", verifyToken, verifyRenter, async (req, res) => {
  let reservationId;
  let inventoryReserved = false;
  try {
    const { equipmentId } = req.params;
    const { startDate, endDate, quantity, contactNumber, deliveryAddress, additionalNotes = "" } = req.body;
    if (!ObjectId.isValid(equipmentId)) return res.status(400).json({ success: false, message: "Invalid equipment ID" });
    if (!Number.isInteger(quantity) || quantity < 1) return res.status(400).json({ success: false, message: "Quantity must be a positive whole number" });
    if (typeof contactNumber !== "string" || !contactNumber.trim() || typeof deliveryAddress !== "string" || !deliveryAddress.trim()) return res.status(400).json({ success: false, message: "Contact number and delivery address are required" });
    if (typeof additionalNotes !== "string" || additionalNotes.length > 1000) return res.status(400).json({ success: false, message: "Additional notes are too long" });
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T00:00:00.000Z`);
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || "") || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || "") || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start < today || end < start) {
      return res.status(400).json({ success: false, message: "Choose valid rental dates. The start date must be today or later." });
    }
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(503).json({ success: false, message: "Online payment is not fully configured. Set the Stripe API key and webhook signing secret on the server." });
    }

    const equipmentIdObject = new ObjectId(equipmentId);
    const equipment = await equipmentCollection.findOne({ _id: equipmentIdObject, status: "approved" });
    if (!equipment) return res.status(404).json({ success: false, message: "Approved equipment not found" });
    const rentalDays = Math.floor((end - start) / 86400000) + 1;
    const billableUnits = Math.ceil(rentalDays / periodDays(equipment.rentalType));
    const totalAmount = Number((equipment.price * billableUnits * quantity).toFixed(2));
    const currency = (process.env.STRIPE_CURRENCY || "bdt").toLowerCase();
    const amountMinor = Math.round(totalAmount * 100);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return res.status(400).json({ success: false, message: "Booking amount is invalid" });

    const reservationResult = await equipmentCollection.updateOne(
      { _id: equipmentIdObject, status: "approved", price: equipment.price, availableQuantity: { $gte: quantity } },
      { $inc: { availableQuantity: -quantity }, $set: { updatedAt: new Date() } }
    );
    if (!reservationResult.matchedCount) return res.status(409).json({ success: false, message: "This equipment no longer has enough quantity available" });
    inventoryReserved = true;

    const now = new Date();
    const reservation = {
      customerId: req.user.id,
      customerName: req.user.name,
      customerEmail: req.user.email,
      ownerId: equipment.ownerId,
      ownerName: equipment.ownerName,
      ownerEmail: equipment.ownerEmail,
      equipmentId: equipmentIdObject,
      equipmentName: equipment.name,
      rentalType: equipment.rentalType,
      unitPrice: equipment.price,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      rentalDays,
      billableUnits,
      quantity,
      contactNumber: contactNumber.trim(),
      deliveryAddress: deliveryAddress.trim(),
      additionalNotes: additionalNotes.trim(),
      totalAmount,
      amountMinor,
      currency,
      status: "pending",
      paymentStatus: "unpaid",
      inventoryReleased: false,
      createdAt: now,
      updatedAt: now,
    };
    const insertResult = await reservationsCollection.insertOne(reservation);
    reservationId = insertResult.insertedId.toString();
    const baseUrl = (process.env.CLIENT_URL || "http://localhost:3000").replace(/\/$/, "");
    const checkoutSession = await getStripe().checkout.sessions.create({
      mode: "payment",
      customer_email: req.user.email,
      client_reference_id: req.user.id,
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amountMinor,
          product_data: {
            name: `${equipment.name} rental`,
            description: `${rentalDays} day(s), ${quantity} item(s), ${startDate} to ${endDate}`.slice(0, 500),
          },
        },
      }],
      metadata: { reservationId, customerId: req.user.id, equipmentId },
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      success_url: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/payment/cancel?reservation_id=${reservationId}`,
    });
    await reservationsCollection.updateOne({ _id: insertResult.insertedId }, { $set: { stripeSessionId: checkoutSession.id, updatedAt: new Date() } });
    res.status(201).json({ success: true, data: { checkoutUrl: checkoutSession.url, totalAmount, currency, rentalDays, billableUnits } });
  } catch (error) {
    console.error("Checkout creation error:", error);
    if (reservationId) await releaseReservation(reservationId, "checkout_failed").catch((releaseError) => console.error("Inventory release error:", releaseError));
    else if (inventoryReserved) await equipmentCollection.updateOne({ _id: new ObjectId(req.params.equipmentId) }, { $inc: { availableQuantity: req.body.quantity } }).catch((releaseError) => console.error("Inventory release error:", releaseError));
    const checkoutError = error?.raw?.message || error?.message;
    const message = error.message === "Stripe is not configured"
      ? "Online payment is not configured yet"
      : process.env.NODE_ENV === "production"
        ? "Could not start checkout"
        : checkoutError || "Could not start checkout";
    res.status(500).json({ success: false, message });
  }
});

// CUSTOMER: cancel an open checkout and release its inventory hold
app.post("/api/customer/checkout/:reservationId/cancel", verifyToken, verifyRenter, async (req, res) => {
  try {
    const { reservationId } = req.params;
    if (!ObjectId.isValid(reservationId)) return res.status(400).json({ success: false, message: "Invalid reservation ID" });
    const reservation = await reservationsCollection.findOne({ _id: new ObjectId(reservationId), customerId: req.user.id, status: "pending" });
    if (!reservation) return res.json({ success: true, message: "Reservation is already closed" });
    if (reservation.stripeSessionId) {
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.retrieve(reservation.stripeSessionId);
      if (session.status === "open") await stripe.checkout.sessions.expire(reservation.stripeSessionId);
      else if (session.payment_status === "paid") return res.json({ success: true, message: "Payment is being confirmed" });
    }
    await releaseReservation(reservationId, "cancelled");
    res.json({ success: true, message: "Checkout cancelled" });
  } catch (error) {
    console.error("Checkout cancellation error:", error);
    res.status(500).json({ success: false, message: "Could not cancel checkout" });
  }
});

// CUSTOMER: retrieve their own Checkout result for the confirmation screen
app.get("/api/customer/checkout/:sessionId", verifyToken, verifyRenter, async (req, res) => {
  try {
    const session = await getStripe().checkout.sessions.retrieve(req.params.sessionId);
    if (session.client_reference_id !== req.user.id) return res.status(404).json({ success: false, message: "Checkout session not found" });
    if (session.payment_status === "paid") await fulfillCheckout(session);
    const rental = await rentalsCollection.findOne({ checkoutSessionId: session.id }, { projection: { _id: 1, equipmentName: 1 } });
    res.json({ success: true, data: { paymentStatus: session.payment_status, bookingCreated: Boolean(rental), equipmentName: rental?.equipmentName || "", bookingId: rental?._id.toString() || "" } });
  } catch (error) {
    console.error("Checkout status fetch error:", error);
    res.status(404).json({ success: false, message: "Checkout session not found" });
  }
});

const completeDueRentals = async () => {
  if (completionJobRunning || !rentalsCollection) return;
  completionJobRunning = true;
  try {
    const now = new Date();
    const dueRentals = await rentalsCollection.find({
      status: "approved",
      inventoryReleased: { $ne: true },
      $or: [
        { endDate: { $lte: now.toISOString() } },
        { endDate: { $lte: now } },
      ],
    }).toArray();
    for (const rental of dueRentals) {
      const result = await rentalsCollection.updateOne(
        { _id: rental._id, status: "approved", inventoryReleased: { $ne: true } },
        { $set: { status: "completed", bookingStatus: "completed", completedAt: now, inventoryReleased: true, updatedAt: now } }
      );
      if (!result.modifiedCount) continue;
      await equipmentCollection.updateOne(
        { _id: rental.equipmentId },
        { $inc: { availableQuantity: rental.quantity || rental.requiredQuantity || 0 } }
      );
      await notifyRental(
        [rental.customerEmail, rental.ownerEmail],
        `Rental completed: ${rental.equipmentName || "equipment"}`,
        `The rental for ${rental.equipmentName || "your equipment"} has been marked complete.`
      );
    }
  } catch (error) {
    console.error("Scheduled rental completion failed:", error);
  } finally {
    completionJobRunning = false;
  }
};

// Start server
async function startServer() {
  try {
    await client.connect();

    db = client.db(process.env.DB_NAME || "sharekit");

    equipmentCollection = db.collection("equipment");
    rentalsCollection = db.collection("rentals");
    usersCollection = db.collection("user");
    reservationsCollection = db.collection("rentalReservations");
    paymentsCollection = db.collection("payments");
    await rentalsCollection.createIndex({ checkoutSessionId: 1 }, { unique: true, sparse: true });
    await paymentsCollection.createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true });

    // Better Auth uses the same MongoDB database and secret
    auth = betterAuth({
      database: mongodbAdapter(db, {
        client,
      }),

      baseURL: process.env.BETTER_AUTH_URL,

      secret: process.env.BETTER_AUTH_SECRET,

      user: {
        additionalFields: {
          role: {
            type: "string",
            required: false,
            defaultValue: "customer",
            input: false,
          },
        },
      },
    });

    console.log("MongoDB connected successfully");
    console.log("Better Auth session verification configured");
    await completeDueRentals();
    cron.schedule("0 * * * *", () => {
      void completeDueRentals();
    }, { timezone: "UTC" });

    app.listen(PORT, () => {
      console.log(`ShareKit server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
}

startServer();
