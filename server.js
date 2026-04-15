const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();

// ✅ CORS configuration
// app.use(
//   cors({
//     origin: "http://localhost:3001",   // your React app URL
//     methods: ["GET", "POST", "PUT", "DELETE"],
//     credentials: true
//   })
// );

const allowedOrigins = [
  "http://localhost:3001",
  "http://localhost:3000",
  "http://localhost:3002",
  "http://192.168.5.62:454"
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS not allowed"));
    }
  }
}));

app.use(bodyParser.json());

// Routes
const apiRoutes = require("./routes/api");
app.use("/api", apiRoutes);

app.get("/", (req, res) => {
  res.send("API Running 🚀");
});

const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`http://localhost:${PORT}`);
});