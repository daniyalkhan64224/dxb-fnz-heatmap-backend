import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

const app = express();
const PORT = process.env.PORT || 8081;

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const allowedOrigins = [
  'http://localhost:8080',       
  'https://df-heatmap-frontend-development.up.railway.app',      
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error(`CORS policy does not allow access from ${origin}`), false);
    }
  }
}));

app.use(express.json());

const registerSchema = z.object({
  name: z.string().min(2, { message: "Name must be at least 2 characters" }),
  email: z.string().email({ message: "Invalid email address" }),
  password: z.string().min(8, { message: "Password must be at least 8 characters" }),
  phone: z.string().min(10, { message: "Invalid phone number" })
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, name, password, phone } = registerSchema.parse(req.body);

    const userCheck = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (userCheck.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists.',
      });
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const newUser = await pool.query(
      `INSERT INTO users (name, email, password_hash, phone_number)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, phone_number, created_at`,
      [name, email, passwordHash, phone]
    );

    res.status(201).json({
      success: true,
      message: 'User registered successfully. Please verify your phone.',
      user: newUser.rows[0],
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid registration data.',
        errors: error.errors,
      });
    }

    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'An internal server error occurred.',
    });
  }
});

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