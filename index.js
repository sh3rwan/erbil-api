// index.js (Vercel Serverless Function)

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
        const { data } = await axios.get(FLIGHT_STATUS_URL);
        const $ = cheerio.load(data);
        const flights = [];

        // Target the main flight table
        // Adjust the selector based on the table structure. 
        // Based on a common structure for flight status, we target rows inside the main content area.
        const tableRows = $('.table-flight-info tbody tr');

        tableRows.each((index, element) => {
            const row = $(element);
            const columns = row.find('td');

            // Assuming the columns are in this order:
            // 1: Scheduled Time (ISO string or similar)
            // 2: City (Origin/Destination)
            // 3: Flight No
            // 4: Airline
            // 5: Status
            
            // Safety check for expected number of columns
            if (columns.length >= 5) {
                const scheduled = columns.eq(0).text().trim();
                const city = columns.eq(1).text().trim();
                const flightNo = columns.eq(2).text().trim();
                const airline = columns.eq(3).text().trim();
                const status = columns.eq(4).text().trim();

                // Basic validation and mapping
                if (scheduled && flightNo && status) {
                    flights.push({
                        scheduled, // Time in HH:MM or similar format
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
        // If scraping fails, return the current (potentially empty) cache
        return flightDataCache.flights; 
    }
}

/**
 * Main handler function for the Vercel serverless function.
 */
module.exports = async (req, res) => {
    // 1. --- Handle CORS Pre-flight (OPTIONS method) ---
    if (req.method === 'OPTIONS') {
        setCORSHeaders(res);
        res.writeHead(204); // No Content response for pre-flight success
        res.end();
        return;
    }

    // 2. --- Set CORS Headers for all actual requests (GET/POST) ---
    setCORSHeaders(res);

    // 3. --- Handle Refresh Request ---
    if (req.url.endsWith('/refresh') && req.method === 'POST') {
        // Force a new scrape immediately
        await scrapeFlightData();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ message: 'Refresh requested and data scrape initiated/completed.', lastFetched: flightDataCache.lastFetched }));
        return;
    }

    // 4. --- Check Cache and Scrape if necessary ---
    const now = Date.now();
    const lastFetchedTime = flightDataCache.lastFetched ? new Date(flightDataCache.lastFetched).getTime() : 0;
    const isCacheExpired = now - lastFetchedTime > MAX_CACHE_AGE_MS;

    if (isCacheExpired || flightDataCache.status !== 'ready') {
        await scrapeFlightData();
    }
    
    // 5. --- Filter Data by URL Parameter (arrivals/departures/all) ---
    let filteredFlights = flightDataCache.flights;
    let flightType = 'all'; // Default to all

    const pathParts = req.url.split('/').filter(p => p);
    const lastPart = pathParts[pathParts.length - 1]; // e.g., 'flights', 'arrivals', or 'departures'

    if (lastPart === 'arrivals') {
        flightType = 'Arrivals';
        filteredFlights = flightDataCache.flights.filter(f => f.status.includes('Arrival') || f.status.includes('Landed'));
    } else if (lastPart === 'departures') {
        flightType = 'Departures';
        filteredFlights = flightDataCache.flights.filter(f => f.status.includes('Departure') || f.status.includes('Scheduled'));
    }
    // Note: The logic for filtering arrivals/departures is based on keywords in the status, 
    // as the original page layout groups them in separate tables, but the provided scraper targets only one common table.

    // 6. --- Send Response ---
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
        flights: filteredFlights,
        lastFetched: flightDataCache.lastFetched,
        type: flightType,
        source: 'Erbil Airport'
    }));
};
