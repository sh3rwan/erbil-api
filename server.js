const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const API_URL = 'https://erbilairport.com/en/flights-info/';
const UPDATE_CRON_SCHEDULE = '*/5 * * * *'; // Update every 5 minutes
const APP_ID = typeof __app_id !== 'undefined' ? __app_id : 'default-flight-widget';

// --- State and Caching ---
let flightData = [];
let lastFetched = null;
let isFetching = false;

// --- Express Setup ---
const app = express();

// 🛡️ Security: Rate Limiting (100 requests per 15 mins)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', limiter);

// 🛡️ Security: CORS Setup (Restrict to specific domain in production)
// For local testing, we allow all origins.
const allowedOrigins = [
    'http://localhost:3000', 
    'http://127.0.0.1:5500' // Common live server port
    // In production, change to: 'https://your-domain.com'
];
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or local requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.length === 0) {
            callback(null, true);
        } else {
            // Uncomment the line below in production if you want strict origin checking
            // callback(new Error('Not allowed by CORS'));
            callback(null, true); // Temporarily allowing all for ease of testing
        }
    }
}));
app.use(express.json());

/**
 * Parses flight details from a Cheerio element.
 * NOTE: The selectors here are an *educated guess* based on typical website structures.
 * If the scraping fails, these selectors MUST be updated based on the actual HTML structure of
 * https://erbilairport.com/en/flights-info/
 * @param {cheerio.Element} element - The <tr> element of a flight row.
 * @param {string} type - 'Arrival' or 'Departure'.
 * @returns {object|null} The parsed flight object.
 */
function parseFlightRow($, element, type) {
    // Assuming a <td>-based structure
    const tds = $(element).find('td');

    if (tds.length < 5) {
        // Not a valid data row
        return null;
    }

    // Assuming the columns are: Airline, Flight No, From/To, Scheduled Time, Status
    const airline = $(tds[0]).text().trim();
    const flightNo = $(tds[1]).text().trim();
    const city = $(tds[2]).text().trim(); // Origin for Arrivals, Destination for Departures
    const scheduled = $(tds[3]).text().trim();
    const status = $(tds[4]).text().trim();

    return {
        id: `${flightNo}-${scheduled}-${Date.now()}`,
        type: type,
        airline: airline || 'N/A',
        flightNo: flightNo || 'N/A',
        city: city || 'N/A',
        scheduled: scheduled || 'N/A',
        status: status || 'Scheduled',
        lastUpdated: new Date().toISOString()
    };
}

/**
 * Fetches, scrapes, and caches flight data from the airport website.
 */
async function fetchFlights() {
    if (isFetching) {
        console.log('Skipping fetch: already in progress.');
        return;
    }
    isFetching = true;
    console.log(`[${new Date().toLocaleTimeString()}] Starting flight data fetch...`);

    try {
        const response = await axios.get(API_URL, {
            // Mimic a browser to avoid simple bot detection
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        const newFlights = [];

        // --- SCRAPING LOGIC START ---

        // 1. ARRIVALS (Assuming there is a dedicated table or section for Arrivals)
        const $arrivalTableRows = $('#arrival_table_id tbody tr'); // Placeholder selector
        if ($arrivalTableRows.length > 0) {
            console.log(`Found ${$arrivalTableRows.length} potential arrival rows.`);
            $arrivalTableRows.each((i, el) => {
                const flight = parseFlightRow($, el, 'Arrival');
                if (flight) newFlights.push(flight);
            });
        }

        // 2. DEPARTURES (Assuming there is a dedicated table or section for Departures)
        const $departureTableRows = $('#departure_table_id tbody tr'); // Placeholder selector
        if ($departureTableRows.length > 0) {
            console.log(`Found ${$departureTableRows.length} potential departure rows.`);
            $departureTableRows.each((i, el) => {
                const flight = parseFlightRow($, el, 'Departure');
                if (flight) newFlights.push(flight);
            });
        }
        
        // If the airport uses one single table with a "Type" column, the logic would be simpler, 
        // e.g., $('table.flight-schedule tbody tr').each((i, el) => { ... check the type column ... })

        // --- SCRAPING LOGIC END ---

        if (newFlights.length > 0) {
            flightData = newFlights;
            lastFetched = new Date();
            console.log(`[${lastFetched.toLocaleTimeString()}] Successfully fetched and cached ${flightData.length} flights.`);
        } else {
            console.warn(`[${new Date().toLocaleTimeString()}] Scraped 0 flights. Retaining old data.`);
            // Fallback: If scraping fails, use sample data if the cache is empty
            if (flightData.length === 0) {
                flightData = getSampleData();
                console.log("Using sample data as fallback.");
            }
        }

    } catch (error) {
        console.error(`[${new Date().toLocaleTimeString()}] Error fetching data from ${API_URL}:`, error.message);
        // Fallback: If API call fails, use sample data if the cache is empty
        if (flightData.length === 0) {
            flightData = getSampleData();
            console.log("Using sample data as fallback due to network error.");
        }
    } finally {
        isFetching = false;
    }
}

/**
 * Generates sample data to use as a fallback if scraping fails.
 */
function getSampleData() {
    return [
        { id: 'IA220-1000', type: 'Arrival', airline: 'Iraqi Airways', flightNo: 'IA220', city: 'Baghdad', scheduled: '10:00', status: 'Landed', lastUpdated: new Date().toISOString() },
        { id: 'QR441-1130', type: 'Arrival', airline: 'Qatar Airways', flightNo: 'QR441', city: 'Doha', scheduled: '11:30', status: 'Delayed', lastUpdated: new Date().toISOString() },
        { id: 'TK316-1415', type: 'Departure', airline: 'Turkish Airlines', flightNo: 'TK316', city: 'Istanbul', scheduled: '14:15', status: 'Boarding', lastUpdated: new Date().toISOString() },
        { id: 'FZ206-1600', type: 'Departure', airline: 'FlyDubai', flightNo: 'FZ206', city: 'Dubai', scheduled: '16:00', status: 'Scheduled', lastUpdated: new Date().toISOString() },
    ];
}


// --- API Endpoints ---

// GET /api/flights - Get all flights
app.get('/api/flights', (req, res) => {
    res.json({
        appId: APP_ID,
        flights: flightData,
        lastFetched: lastFetched ? lastFetched.toISOString() : null,
        status: flightData.length > 0 ? 'OK' : 'No Data'
    });
});

// GET /api/flights/arrivals - Get arrivals only
app.get('/api/flights/arrivals', (req, res) => {
    const arrivals = flightData.filter(f => f.type === 'Arrival');
    res.json({
        appId: APP_ID,
        flights: arrivals,
        lastFetched: lastFetched ? lastFetched.toISOString() : null,
        status: arrivals.length > 0 ? 'OK' : 'No Data'
    });
});

// GET /api/flights/departures - Get departures only
app.get('/api/flights/departures', (req, res) => {
    const departures = flightData.filter(f => f.type === 'Departure');
    res.json({
        appId: APP_ID,
        flights: departures,
        lastFetched: lastFetched ? lastFetched.toISOString() : null,
        status: departures.length > 0 ? 'OK' : 'No Data'
    });
});

// POST /api/flights/refresh - Force a data refresh
app.post('/api/flights/refresh', async (req, res) => {
    console.log(`[${new Date().toLocaleTimeString()}] Manual refresh triggered.`);
    await fetchFlights();
    res.json({ message: 'Refresh complete.', flightCount: flightData.length });
});

// GET /health - Server health check
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// --- Initialization ---

// 1. Initial data fetch
fetchFlights();

// 2. Schedule regular data updates
cron.schedule(UPDATE_CRON_SCHEDULE, fetchFlights);
console.log(`Scheduled updates to run with cron: ${UPDATE_CRON_SCHEDULE}`);

// 3. Start Server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`API documentation: http://localhost:${PORT}/api/flights`);
});