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
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Analyze this aerial photo for invasive species. Return a JSON object with the following properties: 'level' (ONLY one of: None, Low, Medium, High, Severe), 'identifiedInvasives' (array of species names), 'removalInstructions' (object with species as keys and removal instructions as values), and 'easiestToRemove' (object with 'name', 'x', and 'y'. x and y must be normalized coordinates between 0.0 and 1.0 pointing to the center of the easiest to remove invasive species in the image). Return valid JSON." },
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

        let jsonResult = {};
        try {
            jsonResult = JSON.parse(response.choices[0].message.content.trim());
        } catch (e) {
            console.error("Failed to parse JSON from OpenAI", e);
        }
        const result = jsonResult.level || "None";

        let averageLabel = "N/A";
        let groupCount = 0;

        if (INVASIVE_LEVELS.hasOwnProperty(result)) {
            const levelValue = INVASIVE_LEVELS[result];

            // 1. Process Image and add star
            let finalImageBuffer = req.file.buffer;
            let processedImageBase64 = null;
            
            try {
                const image = await Jimp.read(req.file.buffer);
                if (jsonResult.easiestToRemove && typeof jsonResult.easiestToRemove.x === 'number' && typeof jsonResult.easiestToRemove.y === 'number') {
                    const starBase64 = "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";
                    const star = await Jimp.read(Buffer.from(starBase64, 'base64'));
                    // Resize star to 10% of width
                    const starWidth = Math.max(30, Math.floor(image.bitmap.width * 0.1));
                    star.resize(starWidth, Jimp.AUTO);
                    
                    const drawX = Math.floor(jsonResult.easiestToRemove.x * image.bitmap.width) - Math.floor(star.bitmap.width / 2);
                    const drawY = Math.floor(jsonResult.easiestToRemove.y * image.bitmap.height) - Math.floor(star.bitmap.height / 2);
                    
                    image.composite(star, drawX, drawY);
                }
                finalImageBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
                processedImageBase64 = "data:image/jpeg;base64," + finalImageBuffer.toString('base64');
            } catch (err) {
                console.error("Failed to process image with Jimp, using original:", err);
            }

            // Save Image (Using /tmp if on Vercel)
            const filename = `scan_${groupId}_${Date.now()}.jpg`;
            const filepath = path.join(uploadsDir, filename);
            try {
                fs.writeFileSync(filepath, finalImageBuffer);
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

            res.json({ 
                result: result, 
                groupAverage: averageLabel, 
                groupCount: groupCount,
                identifiedInvasives: jsonResult.identifiedInvasives || [],
                removalInstructions: jsonResult.removalInstructions || {},
                processedImageBase64: processedImageBase64
            });

        } else {
            // Fallback if AI returns something unexpected
            res.json({ result: result, groupAverage: "N/A", groupCount: 0 });
        }

    } catch (error) {
        console.error("Error processing request:", error);
        res.status(500).json({ error: 'Failed to analyze image' });
    }
});

// Scan Data Endpoint (returns group averages for client-side canvas rendering)
app.get('/scan-data', async (req, res) => {
    try {
        const { data: allScans, error } = await supabase
            .from('scans')
            .select('group_id, invasive_level');

        if (error) throw error;

        const groups = {};
        for (let i = 1; i <= 12; i++) {
            groups[i] = { sum: 0, count: 0, average: 0 };
        }

        if (allScans) {
            allScans.forEach(scan => {
                const gid = parseInt(scan.group_id);
                if (groups[gid]) {
                    groups[gid].sum += scan.invasive_level;
                    groups[gid].count++;
                }
            });
        }

        for (let i = 1; i <= 12; i++) {
            if (groups[i].count > 0) {
                groups[i].average = Math.round(groups[i].sum / groups[i].count);
            }
        }

        res.json({ groups });
    } catch (error) {
        console.error("Error fetching scan data:", error);
        res.status(500).json({ error: 'Failed to fetch scan data' });
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
