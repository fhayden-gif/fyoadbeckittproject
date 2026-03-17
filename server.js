require('dotenv').config();
const express = require('express');
const multer = require('multer');
const OpenAI = require('openai');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Ensure uploads directory exists (use /tmp in Vercel/serverless environments)
const isVercel = process.env.VERCEL || process.env.NOW_REGION;
const uploadsDir = isVercel ? '/tmp' : path.join(__dirname, 'public', 'uploads');
if (!isVercel && !fs.existsSync(uploadsDir)) {
    try {
        fs.mkdirSync(uploadsDir, { recursive: true });
    } catch (err) {
        console.warn('Could not create local uploads dir, continuing anyway...', err);
    }
}

// Configure Multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from 'public' directory

const { createClient } = require('@supabase/supabase-js');
const { Jimp } = require('jimp');

// Initialize OpenAI (Provide fallback string to prevent startup crash on Vercel)
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'dummy-key-to-prevent-startup-crash',
});

// Initialize Supabase (Provide fallback string to prevent startup crash on Vercel)
const supabaseUrl = process.env.SUPABASE_URL || 'https://dummy-url-to-prevent-startup-crash.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'dummy-key-to-prevent-startup-crash';
const supabase = createClient(supabaseUrl, supabaseKey);

const INVASIVE_LEVELS = {
    'None': 0,
    'Low': 1,
    'Medium': 2,
    'High': 3,
    'Severe': 4
};

const LEVEL_NAMES = ['None', 'Low', 'Medium', 'High', 'Severe'];

app.post('/analyze', upload.single('image'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image uploaded' });
    }

    const groupId = req.body.group;
    if (!groupId) {
        return res.status(400).json({ error: 'Group ID is required' });
    }

    try {
        const base64Image = req.file.buffer.toString('base64');
        const dataUrl = `data:${req.file.mimetype};base64,${base64Image}`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Analyze this aerial photo for invasive species. Identify the amount of invasives in that area. Return ONLY one of the following labels: None, Low, Medium, High, Severe." },
                        {
                            type: "image_url",
                            image_url: {
                                "url": dataUrl,
                            },
                        },
                    ],
                },
            ],
        });

        const result = response.choices[0].message.content.trim();

        let averageLabel = "N/A";
        let groupCount = 0;

        if (INVASIVE_LEVELS.hasOwnProperty(result)) {
            const levelValue = INVASIVE_LEVELS[result];

            // 1. Save Image (Using /tmp if on Vercel)
            const filename = `scan_${groupId}_${Date.now()}.jpg`;
            const filepath = path.join(uploadsDir, filename);
            try {
                fs.writeFileSync(filepath, req.file.buffer);
            } catch (err) {
                console.error("Failed to write to local directory:", err);
            }
            
            // In Vercel, local /tmp files aren't persistently servable.
            // Ideally should upload to cloud storage (e.g. Supabase Storage).
            const relativeImagePath = isVercel ? null : `/uploads/${filename}`;

            // 2. Insert into Supabase
            const { error: insertError } = await supabase
                .from('scans')
                .insert([
                    { group_id: groupId, invasive_level: levelValue, image_path: relativeImagePath }
                ]);

            if (insertError) {
                console.error("Supabase Insert Error:", insertError);
            }

            // 2. Fetch all values for this group to calculate average
            const { data: groupData, error: fetchError } = await supabase
                .from('scans')
                .select('invasive_level')
                .eq('group_id', groupId);

            if (fetchError) {
                console.error("Supabase Fetch Error:", fetchError);
            } else if (groupData && groupData.length > 0) {
                const sum = groupData.reduce((a, b) => a + b.invasive_level, 0);
                const average = sum / groupData.length;
                const roundedAverage = Math.round(average);
                averageLabel = LEVEL_NAMES[roundedAverage];
                groupCount = groupData.length;
            }

            res.json({ result: result, groupAverage: averageLabel, groupCount: groupCount });

        } else {
            // Fallback if AI returns something unexpected
            res.json({ result: result, groupAverage: "N/A", groupCount: 0 });
        }

    } catch (error) {
        console.error("Error processing request:", error);
        res.status(500).json({ error: 'Failed to analyze image' });
    }
});

// Map Generation Endpoint (Overlay on Map Base)
app.post('/generate-map', async (req, res) => {
    try {
        // 1. Fetch all group averages from Supabase
        const { data: allScans, error } = await supabase
            .from('scans')
            .select('group_id, invasive_level');

        if (error) throw error;

        // Calculate averages per group
        const groupSums = {};
        const groupCounts = {};

        // Initialize for groups 1-12
        for (let i = 1; i <= 12; i++) {
            groupSums[i] = 0;
            groupCounts[i] = 0;
        }

        allScans.forEach(scan => {
            if (groupSums[scan.group_id] !== undefined) {
                groupSums[scan.group_id] += scan.invasive_level;
                groupCounts[scan.group_id]++;
            }
        });

        // 2. Load Base Image (bundled into function via vercel.json includeFiles)
        const localPath = path.join(__dirname, 'public', 'Realmap.jpg');
        
        console.log('Loading map from:', localPath);
        
        let image;
        try {
            image = await Jimp.read(localPath);
            console.log('Map loaded successfully, dimensions:', image.bitmap.width, 'x', image.bitmap.height);
        } catch (err) {
            console.error("Error loading Realmap.jpg:", err);
            return res.status(500).json({ error: `Could not load base map. Error: ${err.message}` });
        }

        // 3. Define Coordinates (Approximate based on 10 distinct areas)
        // Adjust these coordinates based on your actual map_base.jpg resolution!
        // These are percentage-based (0.0 to 1.0) to work with any image size
        // 3x4 grid mapping: columns at 0.125, 0.375, 0.625, 0.875 and rows at 0.166, 0.5, 0.833
        const coordinates = {
            1: { x: 0.125, y: 0.166 }, 
            2: { x: 0.375, y: 0.166 }, 
            3: { x: 0.625, y: 0.166 }, 
            4: { x: 0.875, y: 0.166 }, 
            5: { x: 0.125, y: 0.5 },  
            6: { x: 0.375, y: 0.5 },  
            7: { x: 0.625, y: 0.5 },  
            8: { x: 0.875, y: 0.5 }, 
            9: { x: 0.125, y: 0.833 }, 
            10: { x: 0.375, y: 0.833 },
            11: { x: 0.625, y: 0.833 },
            12: { x: 0.875, y: 0.833 } 
        };

        const width = image.bitmap.width;
        const height = image.bitmap.height;

        // 4. Overlay Circles
        for (let i = 1; i <= 12; i++) {
            let colorHex;

            // Determine Color
            if (groupCounts[i] === 0) {
                // If no data, maybe no overlay? Or transparent?
                // Let's explicitly mark it as 'Gray' or skip
                // Skipping for now if no data, or we could show Green (None) as default
                // User requirement: "Green means none". Let's assume default is Green/None if no scans.
                colorHex = '#00FF00'; // Green
            } else {
                const avg = groupSums[i] / groupCounts[i];
                const roundedAvg = Math.round(avg);

                switch (roundedAvg) {
                    case 0: colorHex = '#008000'; break; // Green (None)
                    case 1: colorHex = '#0000FF'; break; // Blue (Low)
                    case 2: colorHex = '#FFFF00'; break; // Yellow (Medium)
                    case 3: colorHex = '#FFA500'; break; // Orange (High)
                    case 4: colorHex = '#FF0000'; break; // Red (Severe)
                    default: colorHex = '#008000';
                }
            }

            // Create a circle image to composite
            // Radius proportional to image size, e.g., 5% of width
            const radius = Math.floor(width * 0.05);
            const circle = new Jimp({ width: radius * 2, height: radius * 2, color: 0x00000000 }); // Transparent

            // Draw circle manually or use scan/pixel methods
            // Jimp doesn't have a simple 'drawCircle' method in basic version, 
            // but we can scan pixels.
            // Or simpler: just color the whole square block semi-transparently?
            // "Highlight the area around".

            // Let's create a semi-transparent colored block for simplicity/reliability
            // with a mask if possible, or just a square for now if circle is hard.
            // Actually, scanning a circle is easy.

            const center = radius;
            const rSquared = radius * radius;

            // Convert Hex to Int with Alpha (e.g. 50% opacity = 0x80)
            const colorInt = parseInt(colorHex.replace('#', '') + '80', 16);

            circle.scan(0, 0, circle.bitmap.width, circle.bitmap.height, function (x, y, idx) {
                const dx = x - center;
                const dy = y - center;
                if (dx * dx + dy * dy <= rSquared) {
                    this.setPixelColor(colorInt, x, y);
                }
            });

            // Overlay position
            const xPos = Math.floor((coordinates[i].x * width) - radius);
            const yPos = Math.floor((coordinates[i].y * height) - radius);

            image.composite(circle, xPos, yPos);

            // Optional: Add Number Text? 
            // Jimp loadFont takes time and promises.
            // Let's just overlay the color for now as requested.
        }

        // 5. Get Buffer and Return
        const buffer = await image.getBuffer('image/jpeg');
        const base64Image = buffer.toString('base64');
        const dataUrl = `data:image/jpeg;base64,${base64Image}`;

        res.json({ imageUrl: dataUrl });

    } catch (error) {
        console.error("Error generating map:", error);
        if (error.code) console.error("Error code:", error.code);
        if (error.message) console.error("Error message:", error.message);
        res.status(500).json({ error: 'Failed to generate map', details: error.message });
    }
});

app.get('/groups/:id/images', async (req, res) => {
    const groupId = req.params.id;
    try {
        const { data, error } = await supabase
            .from('scans')
            .select('image_path')
            .eq('group_id', groupId)
            .not('image_path', 'is', null)
            .order('created_at', { ascending: false });

        if (error) {
            throw error;
        }

        const images = data.map(scan => scan.image_path);
        res.json({ images });

    } catch (error) {
        console.error("Error fetching group images:", error);
        res.status(500).json({ error: 'Failed to fetch images' });
    }
});

if (process.env.NODE_ENV !== 'production' && !isVercel) {
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
}

// Export the app for Vercel Serverless Function compatibility
module.exports = app;
