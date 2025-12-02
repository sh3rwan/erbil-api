const axios = require('axios');
const cheerio = require('cheerio');

// --- Global Cache for Flight Data ---
let flightDataCache = {
    flights: [],
    lastFetched: null,
    status: 'stale' // 'stale', 'fetching', 'ready'
};

// URL of the flight status page
const FLIGHT_STATUS_URL = 'https://erbilairport.com/page.php?id=8'; 
const MAX_CACHE_AGE_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Applies CORS headers to the response object.
 * @param {object} res - The response object from the Vercel request.
 */
function setCORSHeaders(res) {
    // Allows requests from any origin (*)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}


/**
 * Scrapes the flight data table from the website.
 * @returns {Promise<Array>} A promise that resolves to an array of flight objects.
 */
async function scrapeFlightData() {
    flightDataCache.status = 'fetching';
    console.log('--- Starting data scrape ---');

    try {
        // Use a user-agent header to mimic a regular browser and avoid being blocked
        const { data } = await axios.get(FLIGHT_STATUS_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const $ = cheerio.load(data);
        const flights = [];

        // Target the main flight table
        const tableRows = $('.table-flight-info tbody tr');

        tableRows.each((index, element) => {
            const row = $(element);
            const columns = row.find('td');

            // Assuming the columns are in this order: Time, City, Flight No, Airline, Status
            if (columns.length >= 5) {
                const scheduled = columns.eq(0).text().trim();
                const city = columns.eq(1).text().trim();
                const flightNo = columns.eq(2).text().trim();
                const airline = columns.eq(3).text().trim();
                const status = columns.eq(4).text().trim();

                if (scheduled && flightNo && status) {
                    flights.push({
                        scheduled, 
                        city,
                        flightNo,
                        airline,
                        status
                    });
                }
            }
        });

        console.log(`--- Scrape successful. Found ${flights.length} flights. ---`);

        // Update cache
        flightDataCache.flights = flights;
        flightDataCache.lastFetched = new Date().toISOString();
        flightDataCache.status = 'ready';
        
        return flights;

    } catch (error) {
        console.error('Scraping failed:', error.message);
        flightDataCache.status = 'stale';
        return flightDataCache.flights; 
    }
}

/**
 * Main handler function for the Vercel serverless function.
 * Since the file is named flights.js, the base URL is /api/flights.
 */
module.exports = async (req, res) => {
    // 1. --- Handle CORS Pre-flight (OPTIONS method) ---
    if (req.method === 'OPTIONS') {
        setCORSHeaders(res);
        res.writeHead(204); 
        res.end();
        return;
    }

    // 2. --- Set CORS Headers for all actual requests (GET/POST) ---
    setCORSHeaders(res);

    // 3. --- Handle Refresh Request (Targeting /api/flights/refresh) ---
    // The base path is already /api/flights, so we look for /refresh
    if (req.url.endsWith('/refresh') && req.method === 'POST') {
        await scrapeFlightData();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ message: 'Refresh requested and data scrape initiated/completed.', lastFetched: flightDataCache.lastFetched }));
        return;
    }

    // 4. --- Handle Filtering Requests (Targeting /api/flights/arrivals or /api/flights/departures) ---
    let filteredFlights = flightDataCache.flights;
    let flightType = 'all'; 

    const urlParts = req.url.split('/');
    const filterType = urlParts[urlParts.length - 1].toLowerCase(); 

    if (filterType === 'arrivals') {
        flightType = 'Arrivals';
        filteredFlights = flightDataCache.flights.filter(f => f.status.toLowerCase().includes('arrival') || f.status.toLowerCase().includes('landed'));
    } else if (filterType === 'departures') {
        flightType = 'Departures';
        filteredFlights = flightDataCache.flights.filter(f => f.status.toLowerCase().includes('departure') || f.status.toLowerCase().includes('scheduled'));
    }

    // 5. --- Check Cache and Scrape if necessary (Only if not a specific filter request or refresh) ---
    const now = Date.now();
    const lastFetchedTime = flightDataCache.lastFetched ? new Date(flightDataCache.lastFetched).getTime() : 0;
    const isCacheExpired = now - lastFetchedTime > MAX_CACHE_AGE_MS;

    if (isCacheExpired || flightDataCache.status !== 'ready') {
        await scrapeFlightData();
        // Use newly scraped data for filtering if the scrape just happened
        if (flightDataCache.status === 'ready') {
             // Re-run filter logic on new data
            if (filterType === 'arrivals') {
                filteredFlights = flightDataCache.flights.filter(f => f.status.toLowerCase().includes('arrival') || f.status.toLowerCase().includes('landed'));
            } else if (filterType === 'departures') {
                filteredFlights = flightDataCache.flights.filter(f => f.status.toLowerCase().includes('departure') || f.status.toLowerCase().includes('scheduled'));
            } else {
                filteredFlights = flightDataCache.flights;
            }
        }
    }
    
    // 6. --- Send Final Response ---
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
        flights: filteredFlights,
        lastFetched: flightDataCache.lastFetched,
        type: flightType,
        source: 'Erbil Airport'
    }));
};
