
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

    req.user = session.user;
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
  requireRole("owner", "admin"),
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
  requireRole("owner", "admin"),
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

// OWNER: Update own equipment
app.patch(
  "/api/equipment/:id",
  requireAuth,
  requireRole("owner", "admin"),
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
  requireRole("owner", "admin"),
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

// Start server
async function startServer() {
  try {
    await client.connect();

    db = client.db(process.env.DB_NAME || "sharekit");

    equipmentCollection = db.collection("equipment");

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
