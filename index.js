
import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { fromNodeHeaders } from "better-auth/node";

const app = express();
const PORT = process.env.PORT || 5000;

const client = new MongoClient(process.env.MONGODB_URI);

let db;
let auth;
let equipmentCollection;
let rentalsCollection;
let usersCollection;

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);

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
const requireAuth = async (req, res, next) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session) {
      return res.status(401).json({
        success: false,
        message: "Please login to continue",
      });
    }

    const account = await usersCollection.findOne(
      userIdQuery(session.user.id),
      { projection: { disabled: 1, role: 1 } }
    );
    if (account?.disabled) {
      return res.status(403).json({ success: false, message: "This account is disabled" });
    }

    req.user = { ...session.user, role: account?.role || session.user.role };
    req.session = session.session;

    next();
  } catch (error) {
    console.error("Authentication error:", error);

    res.status(401).json({
      success: false,
      message: "Authentication failed",
    });
  }
};

// Role authorization middleware
const requireRole = (...roles) => {
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
    } = req.query;

    const query = { status: "approved" };

    if (search && typeof search === "string") {
      const searchRegex = {
        $regex: escapeRegex(search.trim()),
        $options: "i",
      };

      query.$or = [
        { name: searchRegex },
        { category: searchRegex },
        { description: searchRegex },
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

    const equipment = await equipmentCollection
      .find(query)
      .sort(sortOption)
      .toArray();

    res.json({
      success: true,
      count: equipment.length,
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

// OWNER: Add equipment
app.post(
  "/api/equipment",
  requireAuth,
  requireRole("owner"),
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
  requireAuth,
  requireRole("owner"),
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
  requireAuth,
  requireRole("owner"),
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

// OWNER: Update own equipment
app.patch(
  "/api/equipment/:id",
  requireAuth,
  requireRole("owner"),
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
  requireAuth,
  requireRole("owner"),
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
  requireAuth,
  requireRole("admin"),
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
  requireAuth,
  requireRole("admin"),
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
app.get("/api/admin/users", requireAuth, requireRole("admin"), async (_req, res) => {
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

app.patch("/api/admin/users/:id/role", requireAuth, requireRole("admin"), async (req, res) => {
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

app.patch("/api/admin/users/:id/access", requireAuth, requireRole("admin"), async (req, res) => {
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
app.patch("/api/admin/equipment/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid equipment ID" });
    const allowed = ["name", "description", "category", "location", "price", "rentalType", "availableQuantity", "condition", "brand", "model", "image", "rentalTerms"];
    const updateData = Object.fromEntries(allowed.filter((field) => req.body[field] !== undefined).map((field) => [field, req.body[field]]));
    if (!Object.keys(updateData).length) return res.status(400).json({ success: false, message: "No valid fields provided" });
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

app.delete("/api/admin/equipment/:id", requireAuth, requireRole("admin"), async (req, res) => {
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
app.get("/api/admin/rentals", requireAuth, requireRole("admin"), async (_req, res) => {
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

app.patch("/api/admin/rentals/:id/status", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!ObjectId.isValid(id)) return res.status(400).json({ success: false, message: "Invalid rental ID" });
    if (!["pending", "approved", "rejected", "cancelled", "completed"].includes(status)) return res.status(400).json({ success: false, message: "Invalid booking status" });
    const result = await rentalsCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status, bookingStatus: status, updatedAt: new Date() } });
    if (!result.matchedCount) return res.status(404).json({ success: false, message: "Rental not found" });
    res.json({ success: true, message: "Rental status updated" });
  } catch (error) {
    console.error("Admin rental status update error:", error);
    res.status(500).json({ success: false, message: "Failed to update rental status" });
  }
});

// Any signed-in user: read and update their own profile
app.get("/api/profile", requireAuth, async (req, res) => {
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

app.patch("/api/profile", requireAuth, async (req, res) => {
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
app.get("/api/customer/rentals", requireAuth, requireRole("customer"), async (req, res) => {
  try {
    const identityValues = [req.user.id, req.user.email].filter(Boolean);
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
app.get("/api/customer/favorites", requireAuth, requireRole("customer"), async (req, res) => {
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

app.post("/api/customer/favorites/:equipmentId", requireAuth, requireRole("customer"), async (req, res) => {
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

app.delete("/api/customer/favorites/:equipmentId", requireAuth, requireRole("customer"), async (req, res) => {
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

// Start server
async function startServer() {
  try {
    await client.connect();

    db = client.db(process.env.DB_NAME || "sharekit");

    equipmentCollection = db.collection("equipment");
    rentalsCollection = db.collection("rentals");
    usersCollection = db.collection("user");

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

    app.listen(PORT, () => {
      console.log(`ShareKit server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
}

startServer();
