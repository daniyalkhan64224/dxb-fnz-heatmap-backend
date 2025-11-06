import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import pg from 'pg';

const app = express();
const PORT = process.env.PORT || 8080;

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.use(cors());
app.use(express.json());

app.get('/api/db-check', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    
    res.json({
      message: 'Database connection successful!',
      time: result.rows[0].now,
    });
  } catch (error) {
    console.error('Database connection failed!', error.stack);
    res.status(500).json({
      message: 'Database connection failed!',
      error: error.message,
    });
  }
});

app.get('/api/heatmap/demo', (req, res) => {
  console.log('Request received for /api/heatmap/demo');

  const demoData = [
    { lat: 25.2048, lon: 55.2708, weight: 0.9 },
    { lat: 25.2040, lon: 55.2710, weight: 1.0 },
    { lat: 25.2055, lon: 55.2715, weight: 0.8 },
    { lat: 25.276987, lon: 55.296249, weight: 0.7 },
    { lat: 25.0945, lon: 55.1567, weight: 0.6 },
    { lat: 25.0950, lon: 55.1570, weight: 0.7 },
    { lat: 24.466667, lon: 54.366669, weight: 0.5 },
    { lat: 24.4670, lon: 54.3670, weight: 0.6 },
  ];

  res.json(demoData);
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});