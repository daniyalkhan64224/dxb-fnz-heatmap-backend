import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import twilio from 'twilio';
import jwt from 'jsonwebtoken';
import http from 'http';
import { WebSocketServer } from 'ws';

const app = express();
const PORT = process.env.PORT || 8081;

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const server = http.createServer(app);

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

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const registerSchema = z.object({
  name: z.string().min(2, { message: "Name must be at least 2 characters" }),
  email: z.string().email({ message: "Invalid email address" }),
  password: z.string().min(8, { message: "Password must be at least 8 characters" }),
  phone: z.string().min(10, { message: "Invalid phone number" })
});

app.post('/api/auth/request-otp', async (req, res) => {
  try {
    const { email, name, password, phone } = registerSchema.parse(req.body);

    const userCheck = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR phone_number = $2',
      [email, phone]
    );

    if (userCheck.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email or phone number already exists.',
      });
    }

    const otp = generateOTP();
    const passwordHash = await bcrypt.hash(password, 10);

    await pool.query(
      'DELETE FROM otp_verifications WHERE email = $1 OR phone_number = $2',
      [email, phone]
    );
    
    await pool.query(
      `INSERT INTO otp_verifications (name, email, password_hash, phone_number, otp_code)
       VALUES ($1, $2, $3, $4, $5)`,
      [name, email, passwordHash, phone, otp]
    );

    try {
      await twilioClient.messages.create({
        body: `Your UAE Noise Monitor verification code is: ${otp}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone,
      });
    } catch (twilioError) {
      console.error('Twilio Error:', twilioError);
      return res.status(500).json({
        success: false,
        message: 'Failed to send OTP. Please check the phone number.',
      });
    }

    res.status(200).json({
      success: true,
      message: 'OTP sent successfully to your phone.',
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid registration data.',
        errors: error.errors.map(e => e.message),
      });
    }

    console.error('Request-OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'An internal server error occurred.',
    });
  }
});

const otpSchema = z.object({
  email: z.string().email({ message: "Invalid email address" }),
  phone: z.string().min(10, { message: "Invalid phone number" }),
  otp: z.string().length(6, { message: "OTP must be 6 digits" })
});

app.post('/api/auth/verify-otp', async (req, res) => {
  let client;
  
  try {
    const { email, phone, otp } = otpSchema.parse(req.body);

    const otpCheck = await pool.query(
      `SELECT * FROM otp_verifications 
       WHERE email = $1 AND phone_number = $2 AND expires_at > NOW()`,
      [email, phone]
    );

    if (otpCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Verification request not found or has expired. Please try again.',
      });
    }

    const verificationData = otpCheck.rows[0];

    if (verificationData.otp_code !== otp) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP code.',
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const newUser = await client.query(
      `INSERT INTO users (name, email, password_hash, phone_number, is_phone_verified)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, name, email, phone_number, created_at`,
      [
        verificationData.name,
        verificationData.email,
        verificationData.password_hash,
        verificationData.phone_number,
      ]
    );
    
    const user = newUser.rows[0];

    await client.query(
      'DELETE FROM otp_verifications WHERE id = $1',
      [verificationData.id]
    );

    await client.query('COMMIT');

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      message: 'Account verified and created successfully!',
      token: token,
      user: user,
    });

  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }

    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid verification data.',
        errors: error.errors.map(e => e.message),
      });
    }

    console.error('Verify-OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'An internal server error occurred.',
    });
  } finally {
    if (client) {
      client.release();
    }
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

const loginSchema = z.object({
  email: z.string().email({ message: "Invalid email address" }),
  password: z.string().min(1, { message: "Password cannot be empty" }),
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const userCheck = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (userCheck.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const user = userCheck.rows[0];

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    delete user.password_hash;
    
    res.status(200).json({
      success: true,
      message: 'Login successful!',
      token: token,
      user: user,
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        message: 'Invalid login data.',
        errors: error.errors.map(e => e.message),
      });
    }

    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'An internal server error occurred.',
    });
  }
});

const wss = new WebSocketServer({ server });

const generateNoiseDataPoints = (count = 300) => {
  const points = [];
  for (let i = 0; i < count / 3; i++) {
    points.push({
      id: `d${i}`,
      lat: 25.2048 + (Math.random() - 0.5) * 0.3,
      lng: 55.2708 + (Math.random() - 0.5) * 0.3,
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

wss.broadcast = function broadcast(data) {
  wss.clients.forEach(function each(client) {
    if (client.readyState === client.OPEN) {
      client.send(data);
    }
  });
};

setInterval(() => {
  const newData = generateNoiseDataPoints(300);
  const payload = JSON.stringify({
    type: 'NOISE_DATA_UPDATE',
    data: newData,
  });
  wss.broadcast(payload);
}, 2000);

wss.on('connection', (ws) => {
  console.log('🚀 Client connected to WebSocket');
  
  ws.send(JSON.stringify({
    type: 'WELCOME',
    message: 'Connected to UAE Noise Monitor WebSocket'
  }));

  ws.on('close', () => {
    console.log('Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket Error:', error);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server (HTTP + WS) is running on port ${PORT}`);
});