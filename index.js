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

function calculateNoiseLevel(altitude) {
  if (altitude === null || altitude > 10000) {
    return 0.1; 
  }
  if (altitude < 1000) {
    return 1.0;
  }
  return 1.0 - (altitude - 1000) / 9000;
}

const UAE_BOX = {
  lamin: 22.64,
  lomin: 51.49,
  lamax: 26.28,
  lomax: 56.38,
};

async function fetchRealFlightData() {
  console.log('Fetching real-time flight data...');
  const url = `https://opensky-network.org/api/states/all?lamin=${UAE_BOX.lamin}&lomin=${UAE_BOX.lomin}&lamax=${UAE_BOX.lamax}&lomax=${UAE_BOX.lomax}`;
  
  const noiseDataPoints = [];
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`OpenSky API error: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (data.states) {
      data.states.forEach((state) => {
        const [
          icao24,       
          callsign,     
          origin_country, 
          time_position,  
          last_contact,   
          longitude,    
          latitude,    
          baro_altitude, 
          on_ground,   
          velocity,    
          true_track,     
          vertical_rate,  
          sensors,      
          geo_altitude,  
          squawk,       
          spi,          
          position_source
        ] = state;

        if (!on_ground && latitude && longitude) {
          const altitude = geo_altitude || baro_altitude;
          const noiseLevel = calculateNoiseLevel(altitude);
          
          noiseDataPoints.push({
            id: icao24,
            lat: latitude,
            lng: longitude,
            noiseLevel: 60 + (noiseLevel * 30),
            source: 'flight',
            emirate: 'UAE',
            timestamp: new Date(time_position * 1000),
            
            altitude_meters: Math.round(altitude),
            speed_kph: Math.round(velocity * 3.6),
            geom: `POINT(${longitude} ${latitude})`
          });
        }
      });
    }
    
    console.log(`Fetched ${noiseDataPoints.length} active flights.`);
    return noiseDataPoints;

  } catch (error) {
    console.error('Failed to fetch real flight data:', error.message);
    return [];
  }
}

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
    //   await twilioClient.messages.create({
    //     body: `Your UAE Noise Monitor verification code is: ${otp}`,
    //     from: process.env.TWILIO_PHONE_NUMBER,
    //     to: phone,
    //   });
      console.log(`*** FAKE OTP FOR ${phone}: ${otp} ***`);
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

app.get('/api/buildings/demo', async (req, res) => {
  console.log('Request received for /api/buildings');

  try {
    const { rows } = await pool.query(
      `SELECT 
         id, 
         name, 
         emirate, 
         current_noise,
         -- Use PostGIS to get lat and lng back from the geog column
         ST_Y(geog::geometry) AS lat, -- ST_Y gets Latitude
         ST_X(geog::geometry) AS lng  -- ST_X gets Longitude
       FROM buildings`
    );

    res.json(rows);

  } catch (error) {
    console.error('Error fetching buildings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch buildings from database.'
    });
  }
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

wss.broadcast = function broadcast(data) {
  wss.clients.forEach(function each(client) {
    if (client.readyState === client.OPEN) {
      client.send(data);
    }
  });
};

async function updateAndBroadcastNoiseData() {
  const flightDataPoints = await fetchRealFlightData();
  
  const allNoiseData = flightDataPoints;
  
  if (allNoiseData.length === 0) {
    console.log('No new data, skipping broadcast.');
    return;
  }
  
  const frontendPayload = allNoiseData.map(p => ({
    id: p.id,
    lat: p.lat,
    lng: p.lng,
    noiseLevel: p.noiseLevel,
    source: p.source,
    emirate: p.emirate,
    timestamp: p.timestamp,
  }));
  
  const payload = JSON.stringify({
    type: 'NOISE_DATA_UPDATE',
    data: frontendPayload,
  });
  wss.broadcast(payload);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const values = allNoiseData.map(p => {
      return `(
        'flight', 
        '${p.id.replace(/'/g, "''")}', 
        ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326), 
        ${p.altitude_meters || 'NULL'}, 
        ${p.speed_kph || 'NULL'}, 
        '${p.timestamp.toISOString()}'
      )`;
    }).join(',');

    const query = `
      INSERT INTO noise_sources 
        (source_type, source_id, geom, altitude_meters, speed_kph, created_at)
      VALUES ${values};
    `;

    await client.query(query);
    await client.query('COMMIT');
    
    console.log(`Successfully saved ${allNoiseData.length} data points to DB.`);

  } catch (dbError) {
    await client.query('ROLLBACK');
    console.error('Error saving noise data to database:', dbError.message);
  } finally {
    client.release();
  }
}

async function cleanupOldData() {
  console.log('Running daily cleanup: Deleting data older than 7 days...');
  try {
    const result = await pool.query(
      `DELETE FROM noise_sources WHERE created_at < NOW() - INTERVAL '7 days'`
    );
    if (result.rowCount > 0) {
      console.log(`Cleanup complete. Removed ${result.rowCount} old records.`);
    } else {
      console.log('Cleanup complete. No old records to remove.');
    }
  } catch (err) {
    console.error('Error during old data cleanup:', err.message);
  }
}

setInterval(updateAndBroadcastNoiseData, 10000);

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
setInterval(cleanupOldData, SIX_HOURS_MS);
cleanupOldData();

updateAndBroadcastNoiseData();

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