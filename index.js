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

let trafficDataCache = null;
let trafficCacheTimestamp = null;
const TRAFFIC_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Major UAE routes to fetch traffic data for
const UAE_MAJOR_ROUTES = [
  // Dubai Routes
  { start: { lat: 25.076, lng: 55.132 }, end: { lat: 25.270, lng: 55.330 }, name: 'Sheikh Zayed Road - Dubai', weight: 1.0, emirate: 'Dubai' },
  { start: { lat: 25.050, lng: 55.200 }, end: { lat: 25.320, lng: 55.480 }, name: 'Emirates Road - Dubai', weight: 0.9, emirate: 'Dubai' },
  { start: { lat: 25.060, lng: 55.170 }, end: { lat: 25.180, lng: 55.300 }, name: 'Al Khail Road', weight: 0.85, emirate: 'Dubai' },
  { start: { lat: 25.080, lng: 55.140 }, end: { lat: 25.220, lng: 55.260 }, name: 'Jumeirah Beach Road', weight: 0.75, emirate: 'Dubai' },
  { start: { lat: 25.252, lng: 55.365 }, end: { lat: 25.150, lng: 55.600 }, name: 'Dubai-Al Ain Road', weight: 0.8, emirate: 'Dubai' },
  
  // Dubai-Abu Dhabi Connection (spans both)
  { start: { lat: 25.076, lng: 55.132 }, end: { lat: 24.466, lng: 54.366 }, name: 'Dubai-Abu Dhabi Highway', weight: 0.95, emirate: 'Multiple' },
  
  // Abu Dhabi Routes
  { start: { lat: 24.470, lng: 54.320 }, end: { lat: 24.465, lng: 54.395 }, name: 'Abu Dhabi Corniche', weight: 0.85, emirate: 'Abu Dhabi' },
  { start: { lat: 24.466, lng: 54.366 }, end: { lat: 24.433, lng: 54.651 }, name: 'Abu Dhabi Airport Road', weight: 0.8, emirate: 'Abu Dhabi' },
  { start: { lat: 24.466, lng: 54.366 }, end: { lat: 24.350, lng: 54.800 }, name: 'Abu Dhabi-Al Ain Road', weight: 0.75, emirate: 'Abu Dhabi' },
  
  // Sharjah Routes
  { start: { lat: 25.270, lng: 55.330 }, end: { lat: 25.340, lng: 55.390 }, name: 'Dubai-Sharjah Border', weight: 0.95, emirate: 'Sharjah' },
  { start: { lat: 25.320, lng: 55.440 }, end: { lat: 25.420, lng: 55.540 }, name: 'Emirates Road - Sharjah', weight: 0.85, emirate: 'Sharjah' },
  { start: { lat: 25.340, lng: 55.390 }, end: { lat: 25.405, lng: 55.480 }, name: 'Sharjah-Ajman Road', weight: 0.8, emirate: 'Sharjah' },
  
  // Northern Emirates
  { start: { lat: 25.405, lng: 55.445 }, end: { lat: 25.564, lng: 55.553 }, name: 'Ajman-UAQ Road', weight: 0.7, emirate: 'Ajman' },
  { start: { lat: 25.564, lng: 55.553 }, end: { lat: 25.790, lng: 55.940 }, name: 'UAQ-RAK Road', weight: 0.7, emirate: 'Ras Al Khaimah' },
  
  // East Coast
  { start: { lat: 25.270, lng: 55.330 }, end: { lat: 25.120, lng: 56.330 }, name: 'Dubai-Fujairah Road', weight: 0.75, emirate: 'Fujairah' },
];

async function fetchGoogleTrafficData() {
  const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
  
  if (!GOOGLE_API_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY not found in environment variables');
  }

  const allTrafficPoints = [];

  console.log('🚗 Fetching traffic data from Google Directions API...');

  for (const route of UAE_MAJOR_ROUTES) {
    try {
      const url = `https://maps.googleapis.com/maps/api/directions/json?` +
        `origin=${route.start.lat},${route.start.lng}&` +
        `destination=${route.end.lat},${route.end.lng}&` +
        `departure_time=now&` +
        `traffic_model=best_guess&` +
        `key=${GOOGLE_API_KEY}`;

      const response = await fetch(url);
      const data = await response.json();

      if (data.status !== 'OK') {
        console.error(`❌ Error fetching route ${route.name}:`, data.status);
        continue;
      }

      const routeData = data.routes[0];
      if (!routeData) continue;

      const leg = routeData.legs[0];
      
      // Calculate traffic intensity based on duration vs duration_in_traffic
      const normalDuration = leg.duration.value; // seconds without traffic
      const trafficDuration = leg.duration_in_traffic?.value || normalDuration;
      const trafficRatio = trafficDuration / normalDuration;
      
      // Traffic intensity: 1.0 = no delay, 2.0+ = heavy traffic
      // Map to our 0-1 scale where 1 = worst traffic
      let trafficIntensity = Math.min((trafficRatio - 1.0) * 2.0, 1.0);
      trafficIntensity = Math.max(0.3, trafficIntensity); // Minimum 0.3 for visibility
      
      // Apply route weight (important roads get higher base intensity)
      const finalIntensity = trafficIntensity * route.weight;

      // Extract polyline points
      const polyline = routeData.overview_polyline.points;
      const decodedPoints = decodePolyline(polyline);

      // Create heatmap points along the route
      // Sample every Nth point to avoid too many points
      const samplingRate = Math.max(1, Math.floor(decodedPoints.length / 100)); // Max 100 points per route
      
      for (let i = 0; i < decodedPoints.length; i += samplingRate) {
        const point = decodedPoints[i];
        allTrafficPoints.push({
          lat: point.lat,
          lng: point.lng,
          intensity: finalIntensity,
          route: route.name,
          emirate: route.emirate, // Add emirate info
          trafficRatio: trafficRatio.toFixed(2),
          delay: ((trafficDuration - normalDuration) / 60).toFixed(1) // minutes
        });
      }

      console.log(`✅ ${route.name}: ${decodedPoints.length} points, traffic ratio: ${trafficRatio.toFixed(2)}x, intensity: ${finalIntensity.toFixed(2)}, emirate: ${route.emirate}`);

    } catch (error) {
      console.error(`❌ Error fetching route ${route.name}:`, error.message);
    }
  }

  console.log(`🚗 Total traffic points generated: ${allTrafficPoints.length}`);
  return allTrafficPoints;
}

// Decode Google polyline format
function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let b;
    let shift = 0;
    let result = 0;
    
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;

    shift = 0;
    result = 0;
    
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;

    points.push({
      lat: lat / 1e5,
      lng: lng / 1e5
    });
  }

  return points;
}

app.get('/api/traffic/roads', async (req, res) => {
  console.log('📍 Request received for /api/traffic/roads');

  try {
    const now = Date.now();
    if (trafficDataCache && trafficCacheTimestamp && (now - trafficCacheTimestamp < TRAFFIC_CACHE_DURATION)) {
      console.log('✅ Returning cached traffic data');
      return res.json({
        success: true,
        data: trafficDataCache,
        cached: true,
        cacheAge: Math.floor((now - trafficCacheTimestamp) / 1000) // seconds
      });
    }

    // Fetch fresh data
    console.log('🔄 Fetching fresh traffic data from Google...');
    const trafficData = await fetchGoogleTrafficData();

    // Update cache
    trafficDataCache = trafficData;
    trafficCacheTimestamp = now;

    res.json({
      success: true,
      data: trafficData,
      cached: false,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error fetching traffic data:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch traffic data',
      error: error.message
    });
  }
});

app.post('/api/traffic/refresh', async (req, res) => {
  console.log('🔄 Manual traffic cache refresh requested');
  
  try {
    const trafficData = await fetchGoogleTrafficData();
    trafficDataCache = trafficData;
    trafficCacheTimestamp = Date.now();
    
    res.json({
      success: true,
      message: 'Traffic cache refreshed',
      pointsCount: trafficData.length
    });
  } catch (error) {
    console.error('❌ Error refreshing traffic cache:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to refresh traffic cache',
      error: error.message
    });
  }
});

app.get('/api/heatmap/history', async (req, res) => {
  console.log('Request received for /api/heatmap/history (24h aggregated flight density)');

  try {
    const gridSizeDegrees = 0.005;
    
    const UAE_BOUNDS = {
      minLat: 22.6,
      minLng: 51.55,
      maxLat: 26.3,
      maxLng: 56.38
    };

    const { rows } = await pool.query(
      `
      WITH filtered_points AS (
        -- Get all flight points from last 24 hours within UAE bounds
        SELECT 
          geom,
          created_at
        FROM noise_sources
        WHERE 
          source_type = 'flight'
          AND created_at > NOW() - INTERVAL '24 hours'
          -- Strict boundary enforcement
          AND ST_X(geom::geometry) BETWEEN $2 AND $4
          AND ST_Y(geom::geometry) BETWEEN $1 AND $3
      ),
      grid_cells AS (
        -- Snap each point to a grid cell and count occurrences
        SELECT
          ST_SnapToGrid(geom, $5) AS grid_geom,
          COUNT(*) AS flight_count
        FROM filtered_points
        GROUP BY grid_geom
      ),
      density_normalized AS (
        -- Normalize density to 0-1 scale for better visualization
        SELECT 
          grid_geom,
          flight_count,
          -- Normalize: more flights = higher weight
          LEAST(flight_count::float / 50.0, 1.0) AS normalized_density
        FROM grid_cells
        WHERE flight_count >= 2  -- Filter out noise (single occurrences)
      )
      SELECT 
        ST_Y(grid_geom::geometry) AS lat,
        ST_X(grid_geom::geometry) AS lng,
        flight_count,
        normalized_density,
        -- Calculate noise level (40-90 dB range based on density)
        (40 + (normalized_density * 50))::int AS noise_level
      FROM density_normalized
      ORDER BY flight_count DESC
      `,
      [
        UAE_BOUNDS.minLat,
        UAE_BOUNDS.minLng,
        UAE_BOUNDS.maxLat,
        UAE_BOUNDS.maxLng,
        gridSizeDegrees
      ]
    );
    
    console.log(`✅ Fetched ${rows.length} aggregated density cells from 24h flight data`);

    const heatmapData = rows.map((point, index) => ({
      id: `density-cell-${index}`,
      lat: parseFloat(point.lat),
      lng: parseFloat(point.lng),
      flightCount: parseInt(point.flight_count),
      density: parseFloat(point.normalized_density),
      noiseLevel: parseInt(point.noise_level),
      source: 'flight',
      emirate: 'UAE'
    }));

    res.json(heatmapData);

  } catch (error) {
    console.error('❌ Error fetching aggregated flight density:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch flight density data.'
    });
  }
});

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

// const UAE_BOX = {
//   lamin: 24.0,
//   lomin: 54.0,
//   lamax: 26.28,
//   lomax: 56.25,
// };

// const UAE_BOX = {
//   lamin: 22.6,   // includes Al Ain & Liwa
//   lomin: 51.6,   // includes western UAE near Saudi border
//   lamax: 26.3,   // top border near Ras Al Khaimah
//   lomax: 56.4,   // eastern edge, just before Oman’s Musandam tip
// };

const UAE_BOX = {
  lamin: 22.6,   // south border near Liwa & Al Ain
  lomin: 51.55,  // west border near Saudi Arabia
  lamax: 26.3,   // north border near Ras Al Khaimah
  lomax: 56.38,  // east border near Fujairah but before Oman
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

app.get('/api/traffic/roads', async (req, res) => {
  console.log('📍 Request received for /api/traffic/roads');

  try {
    // Check cache
    const now = Date.now();
    if (trafficDataCache && trafficCacheTimestamp && (now - trafficCacheTimestamp < TRAFFIC_CACHE_DURATION)) {
      console.log('✅ Returning cached traffic data');
      return res.json({
        success: true,
        data: trafficDataCache,
        cached: true,
        cacheAge: Math.floor((now - trafficCacheTimestamp) / 1000) // seconds
      });
    }

    // Fetch fresh data
    console.log('🔄 Fetching fresh traffic data from Google...');
    const trafficData = await fetchGoogleTrafficData();

    // Update cache
    trafficDataCache = trafficData;
    trafficCacheTimestamp = now;

    res.json({
      success: true,
      data: trafficData,
      cached: false,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error fetching traffic data:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch traffic data',
      error: error.message
    });
  }
});

const wss = new WebSocketServer({ server });

let lastKnownFlightData = [];

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

  lastKnownFlightData = frontendPayload;
  
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

setInterval(updateAndBroadcastNoiseData, 60000);

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

  if (lastKnownFlightData.length > 0) {
    ws.send(JSON.stringify({
      type: 'NOISE_DATA_UPDATE',
      data: lastKnownFlightData
    }));
  }

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