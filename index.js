
import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";

const app = express();
const PORT = process.env.PORT || 5000;

const client = new MongoClient(process.env.MONGODB_URI);

let db;

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

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "ShareKit API is healthy",
    database: db ? "Connected" : "Disconnected",
  });
});

async function startServer() {
  try {
    await client.connect();

    db = client.db(process.env.DB_NAME || "sharekit");

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
