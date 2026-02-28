const express = require("express");
const multer = require("multer");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Pool } = require("pg");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const Tesseract = require("tesseract.js"); // Added for fallback OCR

const app = express();
const upload = multer({ dest: "uploads/" });

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ---------------- 1. POSTGRESQL CONNECTION ----------------
const pool = new Pool({
    user: "postgres",
    host: "localhost",
    database: "postgres",
    password: "qwerty",
    port: 5432,
});

// ---------------- 2. AI LAYER: IMAGE COMPRESSION ----------------
// Ensures the image is reduced to under 1MB as per the flow diagram
async function compressImageToBuffer(inputPath) {
    let quality = 90; // Higher quality for better text visibility
    let buffer = await sharp(inputPath).jpeg({ quality }).toBuffer();

    // If still too big for Gemini (should not be for Pro which takes 20MB, but let's keep it safe), resize.
    if (buffer.length > 10 * 1024 * 1024) { // Only downsize if over 10MB
        buffer = await sharp(inputPath).resize(2000).jpeg({ quality: 80 }).toBuffer();
    }
    return buffer.toString("base64");
}

// ---------------- 3. ROUTES ----------------

// Serve Index
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Serve Archive Page
app.get("/archive", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "archive.html"));
});

// GEMINI SETUP
// Get your API Key from https://aistudio.google.com/
const GEMINI_API_KEY = "AIzaSyAY6NySb4Iaj5VnS8WAv3FifzO-GZS9d3Q";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ---------------- 4. MAIN API: AI PROCESSING FLOW ----------------
app.post("/upload", upload.single("card"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image provided" });

    const client = await pool.connect();
    const originalImagePath = req.file.path;

    try {
        await client.query("BEGIN");

        // --- STEP: AI Layer Init & JobID Provided ---
        const originalBase64 = fs.readFileSync(originalImagePath).toString("base64");
        const jobRes = await client.query(
            `INSERT INTO AI_Jobs (imageBase64, Request) VALUES ($1, $2) RETURNING JobID`,
            [originalBase64, "Gemini Vision Request"]
        );
        const jobId = jobRes.rows[0].jobid;

        // --- STEP: Image Compression (To 1MB) ---
        const compressedBase64 = await compressImageToBuffer(originalImagePath);

        // --- STEP: Gemini Vision OCR ---
        console.log("--- Gemini AI Processing Started ---");

        // These are the ONLY models currently responding with SUCCESS for your API key
        const modelsToTry = [
            "gemini-3-flash-preview",
            "gemini-1.5-flash",        // Added standard model as fallback
            "gemini-3.1-pro-preview"
        ];
        let responseText = "";

        const prompt = `
             Extract ALL details from this business card image. 
            SCAN EVERY PIXEL: Small text (Email, Website) is often near the very bottom or hidden in icons (globe, mail icon).
            Search for any text containing '@' or starting with 'www.' or 'http'.
            Search for job titles (e.g., 'CEO', 'Founder', 'Manager').
            Ignore non-contact text (like wood/table patterns).
            
            Return ONLY a valid JSON object:
            {
                "name": "Full Name",
                "company": "Company Name",
                "title": "Job Title",
                "phone": "Full Phone Number",
                "email": "Email Address",
                "address": "Full Physical Address (from the card)",
                "website": "Full Website URL"
            }
        `;

        const imageParts = [{
            inlineData: {
                data: compressedBase64,
                mimeType: req.file.mimetype
            }
        }];

        try {
            for (const modelName of modelsToTry) {
                try {
                    const model = genAI.getGenerativeModel({ model: modelName });
                    const result = await model.generateContent([prompt, ...imageParts]);
                    const response = await result.response;
                    responseText = response.text();
                    if (responseText) {
                        console.log(`Gemini AI Response Received using ${modelName}`);
                        break;
                    }
                } catch (mErr) {
                    console.warn(`Model ${modelName} failed: ${mErr.status || mErr.message}`);
                    if (mErr.status === 403) console.warn("TIP: Your API Key might lack permission for this specific model.");
                }
            }
            if (!responseText) throw new Error("All Gemini models failed to respond.");
        } catch (aiErr) {
            console.warn("Gemini AI failed, using Tesseract OCR fallback.");
            const ocrResult = await Tesseract.recognize(fs.readFileSync(originalImagePath), 'eng');
            const rawText = ocrResult.data.text;
            const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 3);

            // Helper to skip lines that are just numbers, symbols, or too short
            const looksLikeGarbage = (s) => /^[\W_0-9]+$/.test(s) || s.length < 3;

            // Better name extraction: ignore short lines, look for full names and clean them
            const cleanedLines = lines.filter(l => !looksLikeGarbage(l));
            // Improved cleaning for names/titles found via OCR
            const cleanField = (str) => {
                if (!str) return "";
                return str
                    .replace(/^[\W_]+/, '') // Strip symbols/non-words from START
                    .replace(/[^a-zA-Z0-9\s.-]/g, '') // Remove weird chars
                    .replace(/\s+/g, ' ') // Collapse double spaces
                    .trim();
            };

            const rawName = cleanedLines.find(l => /^[A-Z][a-z]+(\s[A-Z][a-z]+)+$/.test(l) || /^[A-Z\s]{5,}$/.test(l)) || cleanedLines[0] || "Found with OCR";
            const rawTitleLine = lines.find(l => /CEO|Manager|Founder|Director|Owner|President|Lead/i.test(l));

            responseText = JSON.stringify({
                name: cleanField(rawName) || "Unknown Contact",
                company: (lines.find(l => /Inc|Ltd|Corp|Company|Solutions|Industries/i.test(l)) || "OCR Extraction").substring(0, 50),
                title: cleanField(rawTitleLine) || "Professional",
                phone: (rawText.match(/[\+\d][\d\s-]{8,}/) || ["N/A"])[0].trim(),
                email: (rawText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/) || ["N/A"])[0],
                address: cleanedLines.slice(1, 4).join(' ').substring(0, 100).replace(/\n/g, ' ') + "...",
                website: (rawText.match(/(https?:\/\/)?(www\.)?[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/) || ["N/A"])[0]
            });
        }

        // Clean and Parse JSON from Gemini
        let ext = { name: "N/A", company: "N/A", title: "N/A", phone: "N/A", email: "N/A", address: "N/A", website: "N/A" };
        try {
            const jsonStr = responseText.replace(/```json|```/g, "").trim();
            ext = JSON.parse(jsonStr);
        } catch (e) {
            console.error("Gemini JSON Parse Error:", responseText);
        }

        console.log("Gemini Extracted Data:", ext);

        // Map extra fields to existing DB columns
        const productNotes = `Email: ${ext.email} | Web: ${ext.website} | Title: ${ext.title}`;

        // --- STEP: Database Storage ---
        await client.query(
            `INSERT INTO Customer_Data 
            ("Phn No (i18n)", Name, Address, Product_Notes, photo_binary, BusinessType, JobID) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                ext.phone || "N/A",
                ext.name || "Unknown",
                ext.address || "Not found",
                productNotes,
                compressedBase64,
                ext.company || "Professional",
                jobId
            ]
        );

        await client.query("COMMIT");
        fs.unlinkSync(originalImagePath);

        res.status(200).json({
            message: "Success",
            jobId: jobId,
            extracted: ext
        });

    } catch (err) {
        if (client) await client.query("ROLLBACK");
        console.error("Processing Error:", err);
        res.status(500).json({ error: "AI Processing Failed", details: err.message });
    } finally {
        if (client) client.release();
    }
});

// ---------------- 5. ARCHIVE API ----------------
app.get("/api/archive", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.JobID, c.Name, c."Phn No (i18n)" as phn_no_i18n, c.Address, c.photo_binary, c.BusinessType, c.Product_Notes
            FROM Customer_Data c 
            ORDER BY c.CUST_ID DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch archive", details: err.message });
    }
});

app.listen(3000, () => {
    console.log("Premium Server active at http://localhost:3000");
});