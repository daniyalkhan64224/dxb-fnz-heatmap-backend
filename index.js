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

app.get('/api/heatmap/demo', (req, res) => {
  console.log('Request received for /api/heatmap/demo');

  const generateNoiseDataPoints = (count = 300) => {
    const points = [];
    for (let i = 0; i < count / 3; i++) {
      points.push({
        id: `d${i}`,
        lat: 25.2048 + (Math.random() - 0.5) * 0.3,
        lng: 55.2708 + (Math.random() - 0.5) * 0.3, // Use lng
        noiseLevel: 50 + Math.random() * 40,
        source: Math.random() > 0.5 ? 'traffic' : 'flight',
        emirate: 'Dubai',
        timestamp: new Date(),
      });
    }
    for (let i = 0; i < count / 3; i++) {
      points.push({
        id: `ad${i}`,
        lat: 24.4539 + (Math.random() - 0.5) * 0.4,
        lng: 54.3773 + (Math.random() - 0.5) * 0.4,
        noiseLevel: 45 + Math.random() * 35,
        source: Math.random() > 0.6 ? 'traffic' : 'flight',
        emirate: 'Abu Dhabi',
        timestamp: new Date(),
      });
    }
    for (let i = 0; i < count / 3; i++) {
      points.push({
        id: `sh${i}`,
        lat: 25.3463 + (Math.random() - 0.5) * 0.25,
        lng: 55.4209 + (Math.random() - 0.5) * 0.25,
        noiseLevel: 55 + Math.random() * 35,
        source: Math.random() > 0.4 ? 'traffic' : 'flight',
        emirate: 'Sharjah',
        timestamp: new Date(),
      });
    }
    return points;
  };
  
  res.json(generateNoiseDataPoints(300));
});

app.get('/api/buildings/demo', (req, res) => {
  console.log('Request received for /api/buildings/demo');

  const DEMO_BUILDINGS = [
    {
      id: 'b1',
      name: 'Burj Khalifa',
      lat: 25.1972,
      lng: 55.2744,
      emirate: 'Dubai',
      currentNoise: 72,
    },
    {
      id: 'b2',
      name: 'Sheikh Zayed Mosque',
      lat: 24.4129,
      lng: 54.4753,
      emirate: 'Abu Dhabi',
      currentNoise: 58,
    },
    {
      id: 'b3',
      name: 'Sharjah Airport',
      lat: 25.3286,
      lng: 55.5172,
      emirate: 'Sharjah',
      currentNoise: 85,
    },
    {
      id: 'b4',
      name: 'Dubai Marina Mall',
      lat: 25.0784,
      lng: 55.1414,
      emirate: 'Dubai',
      currentNoise: 68,
    },
    {
      id: 'b5',
      name: 'Abu Dhabi Mall',
      lat: 24.4979,
      lng: 54.3832,
      emirate: 'Abu Dhabi',
      currentNoise: 65,
    },
  ];

  res.json(DEMO_BUILDINGS);
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});