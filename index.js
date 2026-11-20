
import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";

const app = express();
const PORT = process.env.PORT || 5000;

const client = new MongoClient(process.env.MONGODB_URI);

let db;
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

// Escape user input before using it in a regular expression
const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Get all approved equipment with search, filtering and sorting
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

    const query = {
      status: "approved",
    };

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

    if (category) {
      query.category = category;
    }

    if (rentalType) {
      query.rentalType = rentalType;
    }

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

// Add new equipment
app.post("/api/equipment", async (req, res) => {
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
      ownerId,
      ownerName,
      ownerEmail,
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
      !ownerId
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
      ownerId,
      ownerName: ownerName || "",
      ownerEmail: ownerEmail || "",
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
});

// Get equipment belonging to an owner
app.get("/api/my-equipment/:ownerId", async (req, res) => {
  try {
    const { ownerId } = req.params;

    if (!ownerId) {
      return res.status(400).json({
        success: false,
        message: "Owner ID is required",
      });
    }

    const equipment = await equipmentCollection
      .find({ ownerId })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      success: true,
      count: equipment.length,
      data: equipment,
    });
  } catch (error) {
    console.error("My equipment fetch error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch your equipment",
    });
  }
});

// Update equipment
app.patch("/api/equipment/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { ownerId, ...updates } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    if (!ownerId) {
      return res.status(400).json({
        success: false,
        message: "Owner ID is required",
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
      if (updates[field] !== undefined) {
        updateData[field] = updates[field];
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

    // Updated listings return to pending approval
    updateData.status = "pending";

    const result = await equipmentCollection.updateOne(
      {
        _id: new ObjectId(id),
        ownerId,
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
});

// Delete equipment
app.delete("/api/equipment/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { ownerId } = req.query;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    if (!ownerId) {
      return res.status(400).json({
        success: false,
        message: "Owner ID is required",
      });
    }

    const result = await equipmentCollection.deleteOne({
      _id: new ObjectId(id),
      ownerId,
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
});

// Start server
async function startServer() {
  try {
    await client.connect();

    db = client.db(process.env.DB_NAME || "sharekit");

    equipmentCollection = db.collection("equipment");

    console.log("MongoDB connected successfully");

    app.listen(PORT, () => {
      console.log(`ShareKit server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
}

startServer();
