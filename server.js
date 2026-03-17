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
                if (groups[scan.group_id]) {
                    groups[scan.group_id].sum += scan.invasive_level;
                    groups[scan.group_id].count++;
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
