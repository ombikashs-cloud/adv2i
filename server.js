const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const { GoogleGenAI, Type } = require("@google/genai");

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

class RequestQueue {
    constructor(delayMs = 2000) {
        this.queue = [];
        this.processing = false;
        this.delayMs = delayMs;
    }

    async add(taskFn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ taskFn, resolve, reject });
            this.process();
        });
    }

    async process() {
        if (this.processing) return;
        if (this.queue.length === 0) return;

        this.processing = true;
        const { taskFn, resolve, reject } = this.queue.shift();

        try {
            const result = await taskFn();
            resolve(result);
        } catch (error) {
            reject(error);
        } finally {
            setTimeout(() => {
                this.processing = false;
                this.process();
            }, this.delayMs);
        }
    }
}

const geminiQueue = new RequestQueue(2000);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
// Disable default index.html serving to allow serving indexx.html at '/'
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Serve the indexx.html portal page as the default root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'indexx.html'));
});

// API Endpoint for Auto-Tagging
app.post('/api/auto-tag', async (req, res) => {
    try {
        const { questions, tagType } = req.body;
        if (!questions || !Array.isArray(questions)) {
            return res.status(400).json({ error: 'Invalid question data provided.' });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
        }

        let instructions = '';
        let schema = null;

        switch (tagType) {
            case 'chapter':
                instructions = `1. "chapter": The most relevant subject-appropriate chapter name (e.g. Digestion, Kinematics, Cell Biology, Quadratic Equations, Coordinate Geometry).\n2. "subConcept": The specific sub-topic or concept within that chapter.`;
                schema = {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            qno: { type: Type.STRING },
                            chapter: { type: Type.STRING },
                            subConcept: { type: Type.STRING }
                        },
                        required: ["qno", "chapter", "subConcept"]
                    }
                };
                break;
            case 'errorType':
                instructions = `1. "errorType": Classify the question as either "Memory" (rote fact/formula memory), "Conceptual" (understanding principles), or "Application" (calculating, solving equations, formula substitution).`;
                schema = {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            qno: { type: Type.STRING },
                            errorType: { type: Type.STRING }
                        },
                        required: ["qno", "errorType"]
                    }
                };
                break;
            case 'answer':
                instructions = `1. "ans": The correct answer option: A, B, C, or D. If unsure, take your best guess.`;
                schema = {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            qno: { type: Type.STRING },
                            ans: { type: Type.STRING }
                        },
                        required: ["qno", "ans"]
                    }
                };
                break;
            case 'cognitive':
                instructions = `1. "cognitiveLevel": Analyze the logic required. For Physics, Chemistry, and Math: tag as "Recall" (rote formula/definition), "Analysis" (solving equations, multi-step calculation), or "Evaluation" (complex reasoning/graphical analysis). For Biology: tag as "Recall" (direct rote facts), "Analysis" (mechanism/comparison), or "Evaluation" (complex statement evaluation).`;
                schema = {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            qno: { type: Type.STRING },
                            cognitiveLevel: { type: Type.STRING }
                        },
                        required: ["qno", "cognitiveLevel"]
                    }
                };
                break;
            case 'ncert':
                instructions = `1. "ncertDirectness": For Biology/Chemistry, how directly is this from NCERT? Tag as "Verbatim" (exact lines), "Derived" (concepts from NCERT but modified), or "External" (outside NCERT scope). For Physics/Math, classify how closely it follows standard syllabus guidelines/NCERT exemplars (Verbatim, Derived, External).`;
                schema = {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            qno: { type: Type.STRING },
                            ncertDirectness: { type: Type.STRING }
                        },
                        required: ["qno", "ncertDirectness"]
                    }
                };
                break;
            case 'format':
                instructions = `1. "formatType": The structural format of the question. Tag as "MCQ", "Assertion-Reason", "Statement I & II", "Match-the-Column", or "Numeric".\n2. "targetTime": Estimated ideal time in seconds to solve this question (e.g. 30, 45, 60, 90).`;
                schema = {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            qno: { type: Type.STRING },
                            formatType: { type: Type.STRING },
                            targetTime: { type: Type.INTEGER }
                        },
                        required: ["qno", "formatType", "targetTime"]
                    }
                };
                break;
            default:
                instructions = `1. "chapter": The most relevant subject-appropriate chapter name.\n2. "subConcept": The specific sub-topic or concept within that chapter.\n3. "errorType": Classify the question as "Memory", "Conceptual", or "Application".\n4. "ans": The correct answer option: A, B, C, or D.`;
                schema = {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            qno: { type: Type.STRING },
                            chapter: { type: Type.STRING },
                            subConcept: { type: Type.STRING },
                            errorType: { type: Type.STRING },
                            ans: { type: Type.STRING }
                        },
                        required: ["qno", "chapter", "subConcept", "errorType", "ans"]
                    }
                };
        }

        let promptText = `Analyze the following questions. For each question, infer the missing fields:
${instructions}

Questions to analyze:\n`;

        questions.forEach((q) => {
            promptText += `\n[Q No: ${q.qno}] (Subject: ${q.subject || 'Biology'})\nText: ${q.text}\n`;
        });

        const reportText = await geminiQueue.add(async () => {
            const response = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: promptText,
                config: {
                    temperature: 0.2,
                    responseMimeType: "application/json",
                    responseSchema: schema
                }
            });
            return response.text;
        });

        try {
            const parsedResults = JSON.parse(reportText);
            return res.json({ results: parsedResults });
        } catch (parseError) {
            console.error("Failed to parse JSON from AI:", reportText);
            return res.status(500).json({ error: 'Failed to parse AI response.' });
        }

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// API Endpoint for Document Difficulty Analysis (PDF/OCR/Text)
app.post('/api/analyze-document', async (req, res) => {
    try {
        const { fileData, mimeType, textContent } = req.body;
        
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
        }

        let promptText = `You are a NEET UG difficulty analysis expert. Your job is to classify each question in this exam paper into Easy, Medium, or Hard using the strict NEET-calibrated rubric below.

## NEET DIFFICULTY RUBRIC
### EASY
- Direct recall of a single definition, fact, or diagram label
- No calculation required, OR a one-step formula substitution
- Covered in NCERT text verbatim or as a highlighted box
- A student with 60% preparation can answer correctly

### MEDIUM
- Requires understanding of a concept, not just recall
- May involve 2-step calculation OR applying a formula with given values requiring unit conversion
- Assertion-Reason or Statement I/II where both statements require independent verification
- Match-the-list questions with 4 items requiring accurate recall of ALL 4 pairs
- A student with 75% preparation can answer correctly

### HARD
- Multi-step calculation (3 or more steps), OR derivation required, OR the formula itself must be recalled AND applied
- Requires integrating knowledge from 2 or more different concepts/chapters
- Tricky or misleading options where a common misconception leads to wrong answer
- Numerical problems requiring dimensional analysis, unit conversion AND formula application together
- Questions testing exceptions, atypical cases, or facts NOT directly in NCERT main text
- Organic reaction mechanism questions requiring arrow-pushing logic or predicting major product through multiple steps
- A student with 90%+ preparation is needed to reliably answer correctly

## SUBJECT-SPECIFIC GUIDANCE
### PHYSICS
- If substituting values into a standard formula (F=ma, V=IR): MEDIUM
- If deriving formula or combining 2+ formulas: HARD
- Purely conceptual multiple-select/statement on EM waves, optics, semiconductors: MEDIUM
- Logic gate / truth table: EASY
- Graph/diagram requiring extracting values AND calculating: HARD

### CHEMISTRY
- IUPAC naming, reaction type ID, structure ID: MEDIUM
- Stoichiometry with mole concept in one step: MEDIUM
- Electrochemistry calculation, Arrhenius, Kc/Kp: HARD
- Matching organic reactions to reagents (4-pair): MEDIUM
- Predicting major product of multi-step organic reaction: HARD
- Qualitative analysis group ID order: HARD
- Coordination chemistry: isomerism MEDIUM, magnetic behaviour HARD

### BIOLOGY (BOTANY + ZOOLOGY)
- Single-word or single-fact recall from NCERT: EASY
- 5 statements (A,B,C,D,E choose correct set): MEDIUM
- Match-the-list with scientists/researchers: MEDIUM
- Assertion-Reason in Biology: MEDIUM
- Specific chromosome numbers, trisomy, genetic disorder mechanisms: HARD
- Multi-concept questions linking 2 chapters: HARD
- Process sequencing (enzyme cycle, spermatogenesis): MEDIUM

## IMPORTANT RULES
1. Do NOT default to Easy for Biology recall unless single-word NCERT verbatim.
2. Do NOT classify any multi-step Physics calculation as Easy.
3. Assertion-Reason and Statement I/II are NEVER Easy — minimum Medium.
4. Match-the-list with 4 pairs is NEVER Easy — minimum Medium.
5. 5 options to evaluate (A,B,C,D,E) is NEVER Easy — minimum Medium.
6. Each question must be tagged to ONE primary chapter only (no slashes).
7. If testing an exception or "most appropriate" nuance, classify one level harder.

Extract all questions and infer their properties. For each question, output:
1. "qno": The question number.
2. "subject": One of "Physics", "Chemistry", "Botany", "Zoology", or "Mathematics" — use the section header (PHYSICS/CHEMISTRY/BOTANY/ZOOLOGY) the question appears under if visible, otherwise infer from content. Never default to Biology for a non-Biology question.
3. "chapter": The ONE primary chapter name.
4. "difficulty": "Easy", "Medium", or "Hard".
5. "reason": A one-line reason (max 12 words) explaining why.
6. "marks": Default to 4.

Return the result STRICTLY as a JSON array of objects. Do not include markdown formatting or any other text.
Format: [{"qno": "1", "subject": "Botany", "chapter": "Cell Biology", "difficulty": "Medium", "reason": "Requires verifying 5 statements independently", "marks": 4}]`;

        const requestBody = {
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: {
                temperature: 0.2,
                responseMimeType: "application/json"
            }
        };

        if (fileData && mimeType) {
            requestBody.contents[0].parts.push({
                inlineData: {
                    mimeType: mimeType,
                    data: fileData
                }
            });
        } else if (textContent) {
            requestBody.contents[0].parts.push({ text: `\n\nDocument Content:\n${textContent}` });
        } else {
            return res.status(400).json({ error: 'No file data or text content provided.' });
        }

        const data = await geminiQueue.add(async () => {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });
            return response.json();
        });

        if (data.error) {
            console.error("Gemini API Error:", data.error);
            const isRateLimit = data.error.code === 429 || String(data.error.message).includes('429') || String(data.error.message).toLowerCase().includes('exhausted');
            const statusCode = isRateLimit ? 429 : 500;
            return res.status(statusCode).json({ error: data.error.message || 'AI provider error.' });
        }

        const rawText = data.candidates[0].content.parts[0].text;
        
        try {
            const parsedResults = JSON.parse(rawText);
            return res.json({ results: parsedResults });
        } catch (parseError) {
            console.error("Failed to parse JSON from AI:", rawText);
            return res.status(500).json({ error: 'Failed to parse AI response.' });
        }

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// API Endpoint for Document Question Extraction (PDF/OCR/Text)
app.post('/api/extract-questions', async (req, res) => {
    try {
        const { fileData, mimeType, textContent } = req.body;
        
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
        }

        let promptText = `You are a NEET UG exam parser. Your job is to extract all questions from this exam paper (PDF or image).

IMPORTANT: NEET papers typically contain FOUR sections in this order: Physics, Chemistry, Botany, Zoology (Botany + Zoology together = Biology). Section headers (e.g. "PHYSICS", "CHEMISTRY", "BOTANY", "ZOOLOGY") usually appear in the document — use them to determine which subject each question belongs to. If a question falls under a Botany or Zoology header, set "subject" to "Botany" or "Zoology" respectively (not the generic "Biology"). Never default to Biology for a question that is clearly Physics, Chemistry, or Math based on its content or section header.

For each question, output:
1. "qno": The question number (e.g., "1", "2").
2. "text": The text of the question (the question stem).
3. "subject": One of "Physics", "Chemistry", "Botany", "Zoology", or "Mathematics" — determined from the section header the question appears under, or from the question's content if no header is visible. This field is REQUIRED for every question and must never be left blank or guessed as a default.
4. "chapter": The primary chapter name within that subject (e.g., Digestion, Kinematics, Cell Biology).
5. "subConcept": The specific sub-topic or concept within that chapter.
6. "errorType": Classify the question as either "Memory" (rote fact), "Conceptual" (understanding principles), or "Application" (calculating/applying formulas).
7. "ans": The correct answer option: A, B, C, or D. If the document has an answer key (e.g., at the end of the document), use it. Otherwise, solve the question to determine the correct answer.

Return the result STRICTLY as a JSON array of objects. Do not include markdown formatting or any other text.
Format: [{"qno": "1", "text": "What is the unit of force?", "subject": "Physics", "chapter": "Laws of Motion", "subConcept": "Newton's Laws", "errorType": "Memory", "ans": "B"}]`;

        const requestBody = {
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: {
                temperature: 0.2,
                responseMimeType: "application/json"
            }
        };

        if (fileData && mimeType) {
            requestBody.contents[0].parts.push({
                inlineData: {
                    mimeType: mimeType,
                    data: fileData
                }
            });
        } else if (textContent) {
            requestBody.contents[0].parts.push({ text: `\n\nDocument Content:\n${textContent}` });
        } else {
            return res.status(400).json({ error: 'No file data or text content provided.' });
        }

        const data = await geminiQueue.add(async () => {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });
            return response.json();
        });

        if (data.error) {
            console.error("Gemini API Error:", data.error);
            const isRateLimit = data.error.code === 429 || String(data.error.message).includes('429') || String(data.error.message).toLowerCase().includes('exhausted');
            const statusCode = isRateLimit ? 429 : 500;
            return res.status(statusCode).json({ error: data.error.message || 'AI provider error.' });
        }

        const rawText = data.candidates[0].content.parts[0].text;

        try {
            const parsedResults = JSON.parse(rawText);
            return res.json({ results: parsedResults });
        } catch (parseError) {
            console.error("Failed to parse JSON from AI:", rawText);
            return res.status(500).json({ error: 'Failed to parse AI response.' });
        }

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// API Endpoint for Document Answer Key Extraction (PDF/OCR/Text)
app.post('/api/extract-answers', async (req, res) => {
    try {
        const { fileData, mimeType, textContent } = req.body;
        
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
        }

        let promptText = `You are a NEET UG answer key parser. Your job is to extract all question numbers and correct answer options (A, B, C, or D) from this document (PDF, image, or text).
For each question, output:
1. "qno": The question number (e.g., "1", "2").
2. "ans": The correct answer option: A, B, C, or D. If unsure, output the option that seems correct.

Return the result STRICTLY as a JSON array of objects. Do not include markdown formatting or any other text.
Format: [{"qno": "1", "ans": "B"}]`;

        const requestBody = {
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: {
                temperature: 0.2,
                responseMimeType: "application/json"
            }
        };

        if (fileData && mimeType) {
            requestBody.contents[0].parts.push({
                inlineData: {
                    mimeType: mimeType,
                    data: fileData
                }
            });
        } else if (textContent) {
            requestBody.contents[0].parts.push({ text: `\n\nDocument Content:\n${textContent}` });
        } else {
            return res.status(400).json({ error: 'No file data or text content provided.' });
        }

        const data = await geminiQueue.add(async () => {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });
            return response.json();
        });

        if (data.error) {
            console.error("Gemini API Error:", data.error);
            const isRateLimit = data.error.code === 429 || String(data.error.message).includes('429') || String(data.error.message).toLowerCase().includes('exhausted');
            const statusCode = isRateLimit ? 429 : 500;
            return res.status(statusCode).json({ error: data.error.message || 'AI provider error.' });
        }

        const rawText = data.candidates[0].content.parts[0].text;
        
        try {
            const parsedResults = JSON.parse(rawText);
            return res.json({ results: parsedResults });
        } catch (parseError) {
            console.error("Failed to parse JSON from AI:", rawText);
            return res.status(500).json({ error: 'Failed to parse AI response.' });
        }

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});


// ═══════════════════════════════════════════════════════════════════════════
// NEET CHAPTER PRIORITY RANKER
// ═══════════════════════════════════════════════════════════════════════════
const NEET_CHAPTER_WEIGHT = {
    'Electromagnetic Induction': 1.8, 'Modern Physics': 1.8, 'Current Electricity': 1.7,
    'Ray Optics': 1.7, 'Electrostatics': 1.6, 'Laws of Motion': 1.6,
    'Rotational Motion': 1.5, 'Alternating Current (AC) Circuits': 1.5,
    'Work, Energy and Power': 1.4, 'Magnetism': 1.4, 'Waves': 1.3,
    'Thermodynamics': 1.3, 'Wave Optics': 1.2, 'Nuclear Physics': 1.2,
    'Mechanics': 1.2, 'Fluid Mechanics': 1.1, 'Oscillations': 1.1,
    'Kinematics': 1.3, 'Electronics': 0.9, 'Units and Dimensions': 0.8,
    'Chemical Bonding': 1.8, 'Electrochemistry': 1.7, 'Coordination Compounds': 1.7,
    'Organic Chemistry': 1.6, 'Equilibrium': 1.5, 'Aldehyde Ketone': 1.5,
    'Alcohol Phenol Ether': 1.4, 'p-Block Elements': 1.4, 'd-Block Elements': 1.3,
    'Thermodynamics (Chem)': 1.3, 'Solutions': 1.3, 'Chemical Kinetics': 1.3,
    'Atomic Structure': 1.2, 'Mole Concept': 1.1, 'States of Matter': 1.0,
    'Genetics and Evolution': 1.9, 'Human Physiology': 1.8, 'Plant Physiology': 1.7,
    'Cell: The Unit of Life': 1.7, 'Reproduction': 1.6, 'Ecology': 1.5,
    'Biotechnology': 1.5, 'Biological Classification': 1.3, 'Biomolecules': 1.3,
    'Microbes in Human Welfare': 1.2, 'Body Fluids and Circulation': 1.4,
    'Excretory Products': 1.3, 'Neural Control': 1.3, 'The Living World': 1.0,
};

// ═══════════════════════════════════════════════════════════════════════════
// NEET BOOK RECOMMENDATION MAP
// Biology = NCERT only (100% NCERT based in NEET)
// Physics = NCERT NOT enough — HC Verma + DC Pandey needed
// Chemistry = Mixed: Organic(MS Chouhan/VK Jaiswal), Inorganic(NCERT+VK Jaiswal), Physical(N Avasthi/NCERT)
// ═══════════════════════════════════════════════════════════════════════════
const NEET_BOOK_MAP = {
    // PHYSICS — NCERT is baseline theory only, NOT enough for numericals
    Physics: {
        default: {
            theory: 'NCERT Physics Class XI/XII (theory reading only)',
            primary: 'HC Verma — Concepts of Physics (Vol 1 & 2)',
            drill: 'DC Pandey — Objective Physics for NEET',
            note: 'NCERT Physics is sufficient for theory understanding only. For NEET numerical problems, HC Verma examples + DC Pandey exercises are mandatory.'
        },
        chapters: {
            'Kinematics':               { primary: 'HC Verma Ch 3-4', drill: 'DC Pandey Mechanics Part 1, Ch 3' },
            'Laws of Motion':           { primary: 'HC Verma Ch 5-6', drill: 'DC Pandey Mechanics Part 1, Ch 5' },
            'Work, Energy and Power':   { primary: 'HC Verma Ch 8', drill: 'DC Pandey Mechanics Part 1, Ch 6' },
            'Rotational Motion':        { primary: 'HC Verma Ch 10', drill: 'DC Pandey Mechanics Part 2, Ch 2' },
            'Fluid Mechanics':          { primary: 'HC Verma Ch 13', drill: 'DC Pandey Mechanics Part 2, Ch 5' },
            'Waves':                    { primary: 'HC Verma Ch 15-16', drill: 'DC Pandey Waves & Thermodynamics, Ch 1' },
            'Thermodynamics':           { primary: 'HC Verma Ch 26-27', drill: 'DC Pandey Waves & Thermodynamics, Ch 4' },
            'Electrostatics':           { primary: 'HC Verma Ch 29-30', drill: 'DC Pandey Electricity & Magnetism, Ch 1' },
            'Current Electricity':      { primary: 'HC Verma Ch 32', drill: 'DC Pandey Electricity & Magnetism, Ch 3' },
            'Magnetism':                { primary: 'HC Verma Ch 34-35', drill: 'DC Pandey Electricity & Magnetism, Ch 5' },
            'Electromagnetic Induction':{ primary: 'HC Verma Ch 38', drill: 'DC Pandey Electricity & Magnetism, Ch 7' },
            'Alternating Current (AC) Circuits': { primary: 'HC Verma Ch 39', drill: 'DC Pandey Electricity & Magnetism, Ch 8' },
            'Ray Optics':               { primary: 'HC Verma Ch 18', drill: 'DC Pandey Optics & Modern Physics, Ch 1' },
            'Wave Optics':              { primary: 'HC Verma Ch 17', drill: 'DC Pandey Optics & Modern Physics, Ch 2' },
            'Modern Physics':           { primary: 'HC Verma Ch 42-45', drill: 'DC Pandey Optics & Modern Physics, Ch 4-6' },
            'Nuclear Physics':          { primary: 'HC Verma Ch 45', drill: 'DC Pandey Optics & Modern Physics, Ch 6' },
            'Electronics':              { primary: 'NCERT Class XII Ch 14', drill: 'DC Pandey Optics & Modern Physics, Ch 8' },
            'Oscillations':             { primary: 'HC Verma Ch 12', drill: 'DC Pandey Waves & Thermodynamics, Ch 1' },
        }
    },

    // CHEMISTRY — split by branch
    Chemistry: {
        Organic: {
            theory: 'NCERT Chemistry Class XI Ch 12-13, Class XII Ch 10-16 (mechanisms only — not enough for NEET)',
            primary: 'MS Chouhan — Elementary Problems in Organic Chemistry (for reaction practice)',
            drill: 'VK Jaiswal — Organic Chemistry for NEET (tricky MCQs)',
            note: 'NCERT Organic covers mechanisms but NEET Organic questions go beyond NCERT. MS Chouhan + VK Jaiswal are mandatory for application-level questions.',
            chapters: ['Organic Chemistry', 'Aldehyde Ketone', 'Alcohol Phenol Ether', 'Amines', 'Biomolecules', 'Polymers']
        },
        Inorganic: {
            theory: 'NCERT Chemistry Class XI Ch 3-5, Class XII Ch 6-9 — read every line, every exception',
            primary: 'VK Jaiswal — Inorganic Chemistry for NEET',
            drill: 'Previous Year NEET Questions chapter-wise (Inorganic)',
            note: 'NCERT Inorganic is the PRIMARY source for NEET — 80% of Inorganic questions come directly from NCERT text. But VK Jaiswal adds the tricky exception-based questions NEET loves.',
            chapters: ['p-Block Elements', 'd-Block Elements', 'Coordination Compounds', 'Chemical Bonding', 'Hydrogen', 'Alkali Metals', 'Alkaline Earth Metals']
        },
        Physical: {
            theory: 'NCERT Chemistry Class XI Ch 1-7, Class XII Ch 1-5 (formulas and theory)',
            primary: 'N Avasthi — Problems in Physical Chemistry for NEET',
            drill: 'RC Mukherjee — Modern Approach to Chemical Calculations',
            note: 'NCERT Physical Chemistry covers theory but NEET numerical questions require N Avasthi level practice. NCERT alone is NOT enough for Physical Chemistry.',
            chapters: ['Mole Concept', 'Thermodynamics (Chem)', 'Equilibrium', 'Electrochemistry', 'Chemical Kinetics', 'Solutions', 'States of Matter', 'Atomic Structure']
        }
    },

    // BIOLOGY — NCERT IS the complete source for NEET. No other book needed.
    Biology: {
        Botany: {
            theory: 'NCERT Biology Class XI — read every word, every table, every diagram label',
            primary: 'NCERT Class XI Biology (this IS the primary and only required source)',
            drill: 'Previous Year NEET Questions chapter-wise (Botany)',
            note: 'NEET Biology is 100% NCERT-based. Every question, including the tricky ones, comes from NCERT text. Do NOT waste time on any other book. Re-read NCERT until you can recall any line.',
            chapters: ['The Living World', 'Biological Classification', 'Plant Kingdom', 'Cell: The Unit of Life', 'Biomolecules', 'Cell Cycle and Cell Division', 'Transport in Plants', 'Mineral Nutrition', 'Photosynthesis', 'Respiration in Plants', 'Plant Growth and Development']
        },
        Zoology: {
            theory: 'NCERT Biology Class XII — every diagram, every table, every exception mentioned',
            primary: 'NCERT Class XII Biology (this IS the primary and only required source)',
            drill: 'Previous Year NEET Questions chapter-wise (Zoology)',
            note: 'NEET Zoology = NCERT Class XII verbatim. Every answer is in the NCERT text. The strategy is reading depth, not reading more books.',
            chapters: ['Digestion and Absorption', 'Breathing and Exchange of Gases', 'Body Fluids and Circulation', 'Excretory Products', 'Locomotion and Movement', 'Neural Control and Coordination', 'Chemical Coordination', 'Reproduction', 'Human Reproduction', 'Genetics and Evolution', 'Human Health and Disease', 'Microbes in Human Welfare', 'Biotechnology', 'Ecology']
        }
    }
};

// ═══════════════════════════════════════════════════════════════════════════
// NCERT COORDINATE MAP — exact chapter numbers to prevent AI hallucination
// ═══════════════════════════════════════════════════════════════════════════
const NCERT_COORDINATES = {
    // Class XI Biology (Botany)
    'The Living World':              'NCERT Class XI Biology, Chapter 1',
    'Biological Classification':     'NCERT Class XI Biology, Chapter 2',
    'Plant Kingdom':                 'NCERT Class XI Biology, Chapter 3',
    'Animal Kingdom':                'NCERT Class XI Biology, Chapter 4',
    'Morphology of Flowering Plants':'NCERT Class XI Biology, Chapter 5',
    'Cell: The Unit of Life':        'NCERT Class XI Biology, Chapter 8',
    'Biomolecules':                  'NCERT Class XI Biology, Chapter 9',
    'Cell Cycle and Cell Division':  'NCERT Class XI Biology, Chapter 10',
    'Transport in Plants':           'NCERT Class XI Biology, Chapter 11',
    'Mineral Nutrition':             'NCERT Class XI Biology, Chapter 12',
    'Photosynthesis':                'NCERT Class XI Biology, Chapter 13',
    'Respiration in Plants':         'NCERT Class XI Biology, Chapter 14',
    'Plant Growth and Development':  'NCERT Class XI Biology, Chapter 15',
    // Class XII Biology (Zoology)
    'Reproduction in Organisms':     'NCERT Class XII Biology, Chapter 1',
    'Sexual Reproduction':           'NCERT Class XII Biology, Chapter 2',
    'Human Reproduction':            'NCERT Class XII Biology, Chapter 3',
    'Reproductive Health':           'NCERT Class XII Biology, Chapter 4',
    'Principles of Inheritance':     'NCERT Class XII Biology, Chapter 5',
    'Molecular Basis of Inheritance':'NCERT Class XII Biology, Chapter 6',
    'Genetics and Evolution':        'NCERT Class XII Biology, Chapters 5-7',
    'Human Health and Disease':      'NCERT Class XII Biology, Chapter 8',
    'Microbes in Human Welfare':     'NCERT Class XII Biology, Chapter 10',
    'Biotechnology':                 'NCERT Class XII Biology, Chapters 11-12',
    'Ecology':                       'NCERT Class XII Biology, Chapters 13-16',
    'Body Fluids and Circulation':   'NCERT Class XII Biology, Chapter 18',
    'Excretory Products':            'NCERT Class XII Biology, Chapter 19',
    'Neural Control':                'NCERT Class XII Biology, Chapter 21',
    'Human Physiology':              'NCERT Class XII Biology, Chapters 17-22',
    'Plant Physiology':              'NCERT Class XI Biology, Chapters 11-15',
    // Chemistry NCERT
    'Atomic Structure':              'NCERT Class XI Chemistry, Chapter 2',
    'Chemical Bonding':              'NCERT Class XI Chemistry, Chapter 4',
    'States of Matter':              'NCERT Class XI Chemistry, Chapter 5',
    'Thermodynamics (Chem)':         'NCERT Class XI Chemistry, Chapter 6',
    'Equilibrium':                   'NCERT Class XI Chemistry, Chapter 7',
    'Mole Concept':                  'NCERT Class XI Chemistry, Chapter 1',
    'p-Block Elements':              'NCERT Class XII Chemistry, Chapter 7',
    'd-Block Elements':              'NCERT Class XII Chemistry, Chapter 8',
    'Coordination Compounds':        'NCERT Class XII Chemistry, Chapter 9',
    'Electrochemistry':              'NCERT Class XII Chemistry, Chapter 3',
    'Chemical Kinetics':             'NCERT Class XII Chemistry, Chapter 4',
    'Solutions':                     'NCERT Class XII Chemistry, Chapter 2',
    'Organic Chemistry':             'NCERT Class XI Chemistry, Chapters 12-13',
    'Aldehyde Ketone':               'NCERT Class XII Chemistry, Chapter 12',
    'Alcohol Phenol Ether':          'NCERT Class XII Chemistry, Chapter 11',
};

// ── Helper: get book guidance for a chapter ─────────────────────────────────
function getBookGuidance(subject, chapter, errorType) {
    const subj = String(subject || '').toLowerCase();

    if (subj === 'physics' || subj === 'mathematics') {
        const phys = NEET_BOOK_MAP.Physics;
        const chBook = phys.chapters[chapter];
        return {
            ncertRole: 'Theory reference only',
            primaryBook: chBook ? chBook.primary : phys.default.primary,
            drillBook: chBook ? chBook.drill : phys.default.drill,
            note: phys.default.note,
            ncertCoord: null  // Physics uses Formula Sets, not NCERT chapter coords
        };
    }

    if (subj === 'chemistry') {
        // Classify as Organic / Inorganic / Physical
        const chem = NEET_BOOK_MAP.Chemistry;
        let branch = chem.Physical; // default
        if (chem.Organic.chapters.some(c => chapter.includes(c) || c.includes(chapter))) branch = chem.Organic;
        else if (chem.Inorganic.chapters.some(c => chapter.includes(c) || c.includes(chapter))) branch = chem.Inorganic;
        return {
            ncertRole: branch === chem.Inorganic ? 'PRIMARY source — read every line' : 'Theory baseline — not sufficient alone',
            primaryBook: branch.primary,
            drillBook: branch.drill,
            note: branch.note,
            ncertCoord: NCERT_COORDINATES[chapter] || null
        };
    }

    if (subj === 'botany' || subj === 'biology') {
        const bio = NEET_BOOK_MAP.Biology.Botany;
        return {
            ncertRole: 'COMPLETE source — NCERT is everything for NEET Botany',
            primaryBook: bio.primary,
            drillBook: bio.drill,
            note: bio.note,
            ncertCoord: NCERT_COORDINATES[chapter] || 'NCERT Class XI Biology (check chapter index)'
        };
    }

    if (subj === 'zoology') {
        const bio = NEET_BOOK_MAP.Biology.Zoology;
        return {
            ncertRole: 'COMPLETE source — NCERT is everything for NEET Zoology',
            primaryBook: bio.primary,
            drillBook: bio.drill,
            note: bio.note,
            ncertCoord: NCERT_COORDINATES[chapter] || 'NCERT Class XII Biology (check chapter index)'
        };
    }

    return { ncertRole: 'Primary reference', primaryBook: 'NCERT', drillBook: 'PYQ practice', note: '', ncertCoord: null };
}

function getTopPriorityChapters(incorrectQuestions, topN = 4) {
    const chapterMap = {};
    for (const q of incorrectQuestions) {
        const key = `${q.subject}||${q.chapter}`;
        if (!chapterMap[key]) {
            chapterMap[key] = { chapter: q.chapter, subject: q.subject, wrong: 0, subConcepts: [], errorTypes: {}, questions: [] };
        }
        chapterMap[key].wrong++;
        if (q.sub && !chapterMap[key].subConcepts.includes(q.sub)) chapterMap[key].subConcepts.push(q.sub);
        chapterMap[key].errorTypes[q.errorType || 'Application'] = (chapterMap[key].errorTypes[q.errorType || 'Application'] || 0) + 1;
        chapterMap[key].questions.push(`Q${q.qno}`);
    }
    const ranked = Object.values(chapterMap).map(ch => ({
        ...ch,
        neetScore: ch.wrong * (NEET_CHAPTER_WEIGHT[ch.chapter] || 1.0),
        dominantError: Object.entries(ch.errorTypes).sort((a,b) => b[1]-a[1])[0]?.[0] || 'Application',
        bookGuidance: getBookGuidance(ch.subject, ch.chapter, null)
    })).sort((a, b) => b.neetScore - a.neetScore);

    return { priority: ranked.slice(0, topN), secondary: ranked.slice(topN), totalChapters: ranked.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// RAHUL SIR SYSTEM INSTRUCTION BUILDER
// ═══════════════════════════════════════════════════════════════════════════
function buildSubjectSpecificInstructions(incorrectQuestions, studentMode) {
    const failedSubjects = new Set((incorrectQuestions || []).map(q => String(q.subject || '').toLowerCase()));

    let systemPrompt = `
You are "Rahul Sir" — the most loved and respected teacher at an elite NEET coaching institute in India.
You have 11 years of teaching experience. You know every student by name.
After every mock test you sit with each student individually, look at their paper, and tell them EXACTLY what happened and what to do next.

YOUR VOICE (non-negotiable):
- Address the student directly by name from the very first line: "Dekh [Name]," or "[Name], sun yaar," — never start with a formal title or third person.
- You NEVER say "the student has demonstrated" or "it is recommended". You say "tune ye kiya" or "tujhe ye problem hai".
- You are honest about what went wrong but NEVER discouraging. You always end with the path forward.
- You give ONE clear priority message per week: "Is hafte bas ye ek cheez karo. Sirf ye."
- Every task has a realistic time estimate. Real homework has a duration.
- You end every task with one personal line connecting effort to the NEET goal.

CRITICAL TEACHING RULES:
1. NEVER give generic advice. "Revise NCERT" alone is not acceptable. Name the exact chapter, section, and what to DO with it (read, write derivation, draw diagram from memory).
2. Triage by NEET impact: the chapter with highest neetScore from the priority list gets tonight's homework. NEVER start with a 1-wrong chapter if a 2+ wrong chapter exists.
3. Every slot must name the SPECIFIC sub-concepts that were wrong (from question data) — not just the chapter name.
4. selfCheck is mandatory — the student must be able to test themselves WITHOUT looking at notes.
5. parentCheckpoint must be understandable by a parent with zero science background.

CRITICAL BOOK GUIDANCE — THIS IS THE MOST IMPORTANT RULE:
The "resource" field in each action plan slot MUST follow these subject-specific rules strictly:

BIOLOGY (Botany + Zoology):
- NEET Biology is 100% NCERT-based. Every single question comes from NCERT text.
- Resource MUST cite exact NCERT Class XI or XII chapter + section (provided in the priority list).
- DO NOT recommend any other book for Biology. Ever. HC Verma, DC Pandey, MS Chouhan are NEVER for Biology.
- The ONLY additional resource allowed: "Previous Year NEET Questions" for practice after NCERT is clear.
- Task instruction: "Read [exact NCERT section], close the book, write a 5-line summary from memory, re-draw [specific diagram] without looking."

PHYSICS:
- NCERT Physics is useful for theory concepts ONLY. It is NOT enough for NEET numerical problems.
- For conceptual gaps (Recall errors): read NCERT theory, then move to HC Verma worked examples.
- For application gaps (Application/Analysis errors): skip NCERT, go directly to HC Verma examples + DC Pandey exercises.
- Resource MUST start with "Formula Set:" followed by the exact formulas, THEN cite the HC Verma/DC Pandey reference.
- Format: "Formula Set: [formulas] | HC Verma [chapter] + DC Pandey [chapter]"
- NEVER cite only NCERT for a Physics numerical problem — it will not help the student.

CHEMISTRY:
- Inorganic Chemistry: NCERT is the PRIMARY source (80% of NEET Inorganic is from NCERT). Read every line. Then VK Jaiswal for tricky MCQs.
- Physical Chemistry: NCERT covers theory but is NOT enough for numericals. N Avasthi is mandatory for practice.
- Organic Chemistry: NCERT covers mechanisms but NEET goes beyond. MS Chouhan for reaction practice, VK Jaiswal for MCQs.
- Resource format: cite NCERT chapter first, then the beyond-NCERT book for that branch.
`;

    if (studentMode === 'TOPPER_OPTIMIZE') {
        systemPrompt += `
TOPPER MODE: This student scored perfectly. DO NOT prescribe revision or NCERT reading.
Your job: competitive positioning — speed, harder papers, identifying micro-weaknesses.
Tone: ambitious and forward-looking. "Tu top 50 mein aa sakta hai — abhi speed aur pressure training baaki hai."\n`;
    }

    if (studentMode === 'ATTEMPT_CRISIS') {
        systemPrompt += `
ATTEMPT CRISIS MODE: More questions left blank than answered wrong. This is a TIME MANAGEMENT emergency.
Tonight's task MUST be exam strategy — 2-pass technique, section time-boxing (Physics 20min, Chem 15min, Bio 25min).
Content revision is secondary. Fix the strategy gap first.\n`;
    }

    return systemPrompt;
}

// ═══════════════════════════════════════════════════════════════════════════
// MODE 1 — FRIENDLY TEACHER VOICE (NO AI, ZERO COST)
// Short, clean, warm Hinglish — no justifications, no deep forensics
// ═══════════════════════════════════════════════════════════════════════════
const MODE1_TEMPLATES = {
    Foundation: {
        tonight:  (ch, subj) => `Aaj raat sirf ${ch} ke basic concepts padho. NCERT ke diagrams ek baar pencil se trace karo — haath se likhoge toh yaad rahega. 30 minute kaafi hai.`,
        day2:     (ch, book) => `Kal subah ${book} se ${ch} ke solved examples dekho. Khud solve karne ki koshish karo pehle, phir answer dekho. Galti hua toh woh step underline karo.`,
        day3:     (topics)  => `Aaj ${(topics.slice(0,2)).join(' aur ')} pe focus karo. Inhi concepts se question aaya tha. Ek page notes banao apne words mein.`,
        day4_5:   (subj)    => `${subj} ke last 3 saal ke PYQ dekho — sirf inhi chapters se. Pattern samjho, ratta mat maaro.`,
        day6_7:   (ch)      => `Week ke aakhir mein ek mini revision karo — ${ch} ke 10 questions time karke solve karo. Improvement dikhega.`,
        selfCheck:(ch)      => `Book band karo. Ek blank page pe ${ch} ke 5 key points likho bina dekhte.`,
        mentor:   (ch)      => `Foundation strong toh NEET strong — ek din ek chapter.`
    },
    Application: {
        tonight:  (ch, subj) => `Aaj raat ${ch} ke jo questions galat hue, unhe dobara karo bina copy dekhe. 20-25 minute.`,
        day2:     (ch, book) => `${book} se ${ch} ke medium difficulty questions karo kal. Easy wale skip karo — tumhara level usse upar hai.`,
        day3:     (topics)  => `${topics[0] || ch} pe aaj thoda zyada time do — yahi tumhara weakest sub-topic hai is chapter mein.`,
        day4_5:   (subj)    => `${subj} ke mixed practice set karo — multiple chapters ek saath. Real exam jaisa feel aayega.`,
        day6_7:   (ch)      => `${ch} ka ek full mock section karo — timed. Phir khud analyse karo kahan time waste hua.`,
        selfCheck:(ch)      => `${ch} ka ek unseen problem bina formula sheet ke solve karo — 5 minute timer lagao.`,
        mentor:   (ch)      => `Tu jaanta hai ye — ab sirf practise ka game hai.`
    },
    Refinement: {
        tonight:  (ch, subj) => `Tumhara ${ch} strong hai — aaj raat advanced problems karo. Tricky wale, jahan concept twist hota hai.`,
        day2:     (ch, book) => `${book} ke highest difficulty questions lo ${ch} se. Inhe solve karna tumhare liye challenge hona chahiye.`,
        day3:     (topics)  => topics.length > 0 ? `Ek chhota sa gap hai — ${topics[0]}. Sirf ise polish karo aaj.` : `Aaj cross-chapter questions karo — yahi NEET mein aata hai.`,
        day4_5:   (subj)    => `${subj} mein tumhara score achha hai. Aaj speed pe kaam karo — same questions, kam time.`,
        day6_7:   (ch)      => `${ch} done. Ab doosre weak subjects pe shift karo — inhe carry forward mat karo.`,
        selfCheck:(ch)      => `${ch} ke 3 hardest questions bina kisi help ke 10 minute mein solve karo.`,
        mentor:   (ch)      => `Tera knowledge problem nahi hai — habits aur speed fix karne hain.`
    }
};

function generateMode1Report(studentData, testMetadata, studentLevel, levelRationale, priorityChapters, errBreakdown) {
    const name      = studentData.name || 'beta';
    const perf      = studentData.performance || {};
    const incorrect = testMetadata.incorrectQuestions || [];
    const tmpl      = MODE1_TEMPLATES[studentLevel] || MODE1_TEMPLATES['Application'];

    // ── Helper: get book reference for a given subject ────────────────
    function bookForSubject(subject, chapter) {
        const subj = (subject || '').toLowerCase();
        const guide = getBookGuidance(subject, chapter, null);
        if (subj === 'physics') return 'HC Verma + DC Pandey';
        if (subj === 'chemistry') return guide.primaryBook ? guide.primaryBook.split('—')[0].trim() : 'NCERT + N Avasthi';
        return 'NCERT'; // Biology (Botany/Zoology)
    }

    // ── Slot assignment: spread across top 4 priority chapters ────────
    // p0 = highest priority, p1 = second, p2 = third, p3 = fourth (or fallback to p0/p1)
    const p  = priorityChapters; // array of { chapter, subject, wrong, subConcepts, dominantError }
    const p0 = p[0] || { chapter: 'Revision', subject: 'Biology', subConcepts: [] };
    const p1 = p[1] || p0;
    const p2 = p[2] || p1;
    const p3 = p[3] || p2;

    const book0 = bookForSubject(p0.subject, p0.chapter);
    const book1 = bookForSubject(p1.subject, p1.chapter);
    const book2 = bookForSubject(p2.subject, p2.chapter);
    const book3 = bookForSubject(p3.subject, p3.chapter);

    const topics0 = (p0.subConcepts || []).slice(0, 3);
    const topics1 = (p1.subConcepts || []).slice(0, 2);

    // Self-check variations per slot
    const selfCheck0 = `${p0.chapter} ka ek unseen problem bina formula sheet ke solve karo — 5 minute timer lagao.`;
    const selfCheck1 = `${p1.chapter} ke 3 key points bina book ke likhkar dekho.`;
    const selfCheck2 = topics1.length > 0
        ? `${topics1[0]} ko ek example se explain karo — bina notes ke.`
        : `${p2.chapter} ke 2 problems solve karo bina help ke.`;
    const selfCheck3 = `Last 3 saal ke ${p3.chapter} ke questions time karke solve karo.`;

    // How many unique subjects are failing
    const uniqueSubjects = [...new Set(p.map(c => c.subject))];
    const subjectSummary = uniqueSubjects.length > 1
        ? `${uniqueSubjects.join(', ')} mein gaps hain`
        : `${p0.subject} mein kuch gaps hain`;

    const actionPlan = {
        tonightHomework: {
            chapter: p0.chapter,
            subject: p0.subject,
            taskType: studentLevel === 'Foundation' ? 'NCERT Active Recall' : 'Error Correction',
            resource: book0,
            taskInHinglish: tmpl.tonight(p0.chapter, p0.subject),
            durationMinutes: studentLevel === 'Foundation' ? 30 : 25,
            selfCheck: selfCheck0,
            mentorNote: tmpl.mentor(p0.chapter)
        },
        day2Task: {
            chapter: p1.chapter,
            subject: p1.subject,
            taskType: 'Concept Re-read',
            resource: book1,
            taskInHinglish: `${p1.chapter} pe kal focus karo — ${book1} se medium difficulty questions karo. ${p1.wrong} questions is chapter mein galat hue the.`,
            durationMinutes: 30,
            selfCheck: selfCheck1,
            mentorNote: `Ek din ek chapter — consistency hi NEET ka formula hai.`
        },
        day3_4Task: {
            chapter: p2.chapter,
            subject: p2.subject,
            taskType: 'Trap-Spotting',
            resource: book2,
            taskInHinglish: topics1.length > 0
                ? `${p2.chapter} mein ${topics1.join(' aur ')} sub-topics pe focus karo — yahi weak points hain. ${book2} se targeted practice karo.`
                : `${p2.chapter} pe aaj zyada time do — ${p2.wrong} questions galat hue the is area mein.`,
            durationMinutes: 35,
            selfCheck: selfCheck2,
            mentorNote: `Sub-concept fix ho gaya toh chapter fix ho gaya.`
        },
        day5MiniTest: {
            instructions: `Aaj woh exact questions dobara karo jo is test mein galat hue the — ${incorrect.slice(0, 5).map(q => `Q${q.qno}`).join(', ')}. Timer lagao, exactly 1 minute per question. Across all subjects — ${uniqueSubjects.join(', ')}.`,
            passCriteria: `${Math.ceil(Math.min(incorrect.length, 5) * 0.7)} out of ${Math.min(incorrect.length, 5)} correct = improvement confirmed.`,
            durationMinutes: Math.min(incorrect.length, 5) * 1 + 5
        },
        day6_7Consolidation: {
            chapter: p3.chapter,
            subject: p3.subject,
            taskType: 'Mixed Practice + Speed Test',
            resource: 'Previous Year NEET Questions',
            taskInHinglish: `Week ke end mein ${p3.chapter} karo — phir ek 20-question mixed set across ${uniqueSubjects.join(' + ')} lao. Real exam feel ke liye timer lagao.`,
            durationMinutes: 40,
            selfCheck: selfCheck3,
            mentorNote: `Ye week ka final push hai — ${uniqueSubjects.join(' aur ')} dono cover ho jayenge.`
        }
    };

    // Summary lists top chapters across all subjects
    const chapterList = p.slice(0, 3).map(c => `${c.chapter} (${c.subject}, ${c.wrong} wrong)`).join('; ');

    return {
        studentLevel,
        levelRationale,
        academicSummary: `${name}, is test mein ${subjectSummary} — fixable hai. Sabse zyada priority: ${p0.chapter} (${p0.wrong} questions). Is hafte systematic karo — har din ek area.`,
        errorAnalysis: {
            conceptualCount:  errBreakdown.conceptual  || 0,
            applicationCount: errBreakdown.application || 0,
            behavioralCount:  errBreakdown.behavioral  || 0,
            forensicDeepDive: `Top weak areas: ${chapterList}. ${incorrect.length} total questions need revision across ${uniqueSubjects.length} subject(s).`
        },
        actionPlan,
        parentCheckpoint: `Aaj raat ${name} se poochiye: "${p0.chapter} aur ${p1.chapter} — dono pe kuch padha aaj? Ek point batao."`,
        parentBriefing: `${name} ko is hafte ${subjectSummary}. Sabse bada gap: ${p0.chapter}. Hum ne 7-din ka plan diya hai jo ${uniqueSubjects.join(' aur ')} dono cover karta hai. Please ensure 30-40 mins daily study this week.`
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// API ENDPOINT — GENERATE AI PRESCRIPTION
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/generate-prescription', async (req, res) => {
    try {
        const { studentData, testMetadata } = req.body;
        if (!studentData || !testMetadata) {
            return res.status(400).json({ error: 'Invalid request payload. studentData and testMetadata are required.' });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
        }

        const incorrectQuestions = testMetadata.incorrectQuestions || [];
        const perf = studentData.performance || {};
        const cogStats = perf.cogStats || {};
        const errBreakdown = perf.errorBreakdown || {};
        const unattemptedCount = perf.totalUnattempted || 0;

        // ── 1. DETERMINISTIC LEVEL RUBRIC ───────────────────────────────────
        const recallAcc   = cogStats.Recall     ? Math.round((cogStats.Recall.correct    / cogStats.Recall.total)    * 100) : null;
        const analysisAcc = cogStats.Analysis   ? Math.round((cogStats.Analysis.correct  / cogStats.Analysis.total)  * 100) : null;
        const evalAcc     = cogStats.Evaluation ? Math.round((cogStats.Evaluation.correct / cogStats.Evaluation.total) * 100) : null;
        const behavioralPct  = perf.totalWrong > 0 ? Math.round(((errBreakdown.behavioral || 0) / perf.totalWrong) * 100) : 0;

        let studentLevel, levelRationale, levelToneInstructions, studentMode;

        if (perf.totalWrong === 0 && unattemptedCount === 0) {
            studentMode = 'TOPPER_OPTIMIZE';
            studentLevel = 'Refinement';
            levelRationale = 'Perfect score — no errors to remediate. Shift to competitive speed training.';
            levelToneInstructions = 'Topper mode: ambitious, forward-looking. No revision tasks. Only harder drills and speed work.';
        } else if (unattemptedCount > perf.totalWrong && unattemptedCount > 3) {
            studentMode = 'ATTEMPT_CRISIS';
            studentLevel = 'Application';
            levelRationale = `${unattemptedCount} unattempted vs ${perf.totalWrong} wrong — exam strategy is the primary gap, not content.`;
            levelToneInstructions = 'Address exam time management before content. 2-pass technique is the emergency fix.';
        } else if (recallAcc !== null && recallAcc < 50) {
            studentMode = 'REMEDIATE';
            studentLevel = 'Foundation';
            levelRationale = `Recall accuracy only ${recallAcc}% — core factual knowledge not yet secured.`;
            levelToneInstructions = 'Foundation student: warm, encouraging. NCERT reading + active recall only. No PYQs, no advanced drills. Phrases: "Pehle base strong karte hain", "Ek cheez ek time pe".';
        } else if ((analysisAcc !== null && analysisAcc < 55) || (evalAcc !== null && evalAcc < 55)) {
            studentMode = 'REMEDIATE';
            studentLevel = 'Application';
            levelRationale = `Recall decent (${recallAcc ?? 'N/A'}%) but Analysis/Evaluation accuracy low — theory known, application breaking down.`;
            levelToneInstructions = 'Application student: confident, ambitious. Timed drills, PYQ analysis, question-type strategy. "Tu jaanta hai ye — ab sirf practise ka game hai."';
        } else if (behavioralPct >= 40) {
            studentMode = 'REMEDIATE';
            studentLevel = 'Refinement';
            levelRationale = `${behavioralPct}% of errors are behavioral — knowledge is there, exam discipline is the gap.`;
            levelToneInstructions = 'Refinement student: sharp, high-standards. NO NCERT re-reading, only speed drills, trap-spotting, accuracy work. "Tera knowledge problem nahi hai — habits fix karne hain."';
        } else {
            studentMode = 'REMEDIATE';
            studentLevel = 'Application';
            levelRationale = 'Mixed profile — conceptual and application gaps both present.';
            levelToneInstructions = 'Balanced: fix top conceptual gap first, then reinforce with targeted drills.';
        }

        // ── 1b. PRIORITY CHAPTER RANKING (needed for both Mode 1 and Mode 2/3) ────────
        const priorityDataEarly = getTopPriorityChapters(incorrectQuestions, 4);
        const weakestChapter    = priorityDataEarly.priority[0]?.chapter || 'the weakest chapter';
        const weakSubConcepts   = priorityDataEarly.priority[0]?.subConcepts || [];

        // ── MODE 1: INSTANT REPORT — no AI, zero cost ─────────────────────
        const prescriptionMode = (studentData.prescriptionMode || 'mode2').toLowerCase();
        if (prescriptionMode === 'mode1') {
            const mode1Report = generateMode1Report(
                studentData, testMetadata,
                studentLevel, levelRationale,
                priorityDataEarly.priority,   // full ranked array, not just weakest chapter
                errBreakdown
            );
            console.log(`✅ Mode 1 report generated for ${studentData.name} — no API call used`);
            return res.json(mode1Report);
        }

        // ── 2. PRIORITY CHAPTER RANKING with book guidance injected ─────────
        const priorityData = getTopPriorityChapters(incorrectQuestions, 4);

        const priorityBlock = studentMode === 'TOPPER_OPTIMIZE'
            ? 'No wrong chapters. Focus: speed simulation and competitive positioning.'
            : `
PRIORITY ATTACK LIST — ranked by NEET impact (wrong × frequency weight):
${priorityData.priority.map((c, i) => {
    const bg = c.bookGuidance;
    return `  ${i+1}. ${c.chapter} (${c.subject}) | ${c.wrong} wrong | NEET score: ${c.neetScore.toFixed(1)}
     Sub-concepts failed: ${c.subConcepts.join(', ') || 'see question data'}
     Dominant error: ${c.dominantError} | Questions: ${c.questions.join(', ')}
     NCERT role: ${bg.ncertRole}
     ${bg.ncertCoord ? `NCERT location: ${bg.ncertCoord}` : ''}
     Primary book: ${bg.primaryBook}
     Drill book: ${bg.drillBook}
     Book note: ${bg.note}`;
}).join('\n\n')}

SECONDARY CHAPTERS (do NOT address in this 7-day plan — leave for next test cycle):
${priorityData.secondary.map(c => `${c.chapter} (${c.wrong} wrong)`).join(', ') || 'None'}

TRIAGE RULE: tonightHomework MUST target Priority Chapter #1. NEVER start with a low-impact chapter.
FOCUS RULE: Address only the top 3-4 chapters across all 5 plan slots.
RESOURCE RULE: Use the exact book references above in the "resource" field — do not invent other books.`;

        // ── 3. LANGUAGE / PERSONA BLOCK (subject-aware examples) ─────────────
        const languageMode = (studentData.languageMode || 'english').toLowerCase();
        const studentName = studentData.name || 'beta';

        // Pick a Hinglish example relevant to what this student actually got wrong
        const failedSubjectsList = [...new Set(incorrectQuestions.map(q => (q.subject || '').toLowerCase()))];
        let hinglishExample = '';
        if (failedSubjectsList.includes('physics')) {
            hinglishExample = `"Dekh ${studentName}, tera Electromagnetic Induction bilkul toot gaya — 2 mein se 2 galat. Aaj raat sirf ek kaam karo: HC Verma Chapter 38 ke examples 38.1 se 38.4 tak padho, flux change ki derivation apne haath se likho. Ek baar ye samajh gaya toh NEET mein EMI ke 2 questions pakka milenge."`;
        } else if (failedSubjectsList.includes('chemistry')) {
            hinglishExample = `"${studentName}, tera Chemical Bonding wala part dekha — Q16 mein tune Micro aur Milli confuse kar diya, ye memory gap hai. Aaj raat NCERT Class XI Chemistry Chapter 4 Section 4.3 padho, table bana — hybridization types aur unke examples. Kal mujhe 5 examples sunana bina book dekhe."`;
        } else if (failedSubjectsList.includes('botany') || failedSubjectsList.includes('zoology') || failedSubjectsList.includes('biology')) {
            hinglishExample = `"${studentName}, Cell Division waala question tera galat hua — Q35 mein tune G2 phase aur S phase ka role swap kar diya. Ye NCERT Class XI Biology Chapter 10, Section 10.2 mein clearly likha hai. Aaj raat ye ek section padho, book band karo, aur bina dekhte 5 lines likho ki interphase mein kya hota hai. Bas itna."`;
        } else {
            hinglishExample = `"Dekh ${studentName}, aaj ka paper dekha — gaps hain but sab fixable hai. Is hafte priority list ke hisaab se chalte hain."`;
        }

        const langBlock = languageMode === 'hinglish' ? `
LANGUAGE — HINGLISH MODE:
Write ALL text fields in Rahul Sir's natural Hinglish voice. Rules:
- Technical terms always stay in English: chapter names, formula names, book names, Q numbers, NCERT, HC Verma, DC Pandey.
- Casual Hindi + English mix. NOT formal Hindi. NOT textbook language.
- GOOD example for this student's subjects: ${hinglishExample}
- BAD: "छात्र को अध्याय का पुनरावलोकन करना चाहिए।" ← Never this.
- Every taskInHinglish: start by naming the exact sub-concept that was wrong (from Q data), then give the exact task with book + chapter, then end with ONE motivational line.
- parentCheckpoint: write something a non-science parent can literally read aloud to their child tonight.`
        : `
LANGUAGE — ENGLISH MODE:
Write like Rahul Sir writing a personal letter — warm, direct, specific, never robotic.
- GOOD: "${studentName}, your Biology recall is solid but Q35 shows you mixed up G2 phase and S phase — that's one line in NCERT Class XI Chapter 10 you need to fix tonight. Read Section 10.2, close the book, write it from memory. That's it for today."
- BAD: "The student has demonstrated suboptimal performance in cell cycle questions."
- Every taskInHinglish (use this field even in English mode): name the specific Q number and sub-concept, give exact book+chapter, end with personal connection to NEET.
- parentCheckpoint: plain English, no formulas, no technical terms.`;

        // ── 4. FULL PROMPT ───────────────────────────────────────────────────
        const mode2HinglishStructure = languageMode === 'hinglish' ? `
STRUCTURE YOUR RESPONSE EXACTLY LIKE THIS — no deviations:

🔴 ROOT CAUSE (2 lines max):
Naam lekar bolo — exactly kya hua is test mein. Generic mat bolo.

📚 READING SEQUENCE (numbered — student must know WHY each step comes before the next):
1. TONIGHT (Day 1): [Exact task] | [Exact book + chapter + section] | WHY FIRST: [one line reason]
2. DAY 2: [Exact task] | [Exact resource] | WHY NOW: [builds on Day 1 because...]
3. DAY 3-4: [Exact task] | [Exact resource] | WHY NOW: [reason]
4. DAY 5 MINI TEST: Redo exactly Q[numbers] — timed. Pass criteria: X/Y correct.
5. DAY 6-7: [Consolidation task] | [Resource] | WHAT TO MEASURE: [specific outcome]

⚡ EK CHEEZ BAND KARO:
[The single biggest mistake this student is making — specific, not generic]

✅ SUCCESS SIGNAL:
[Exactly how student will know this week worked — measurable]
` : `
STRUCTURE YOUR RESPONSE EXACTLY LIKE THIS:

🔴 ROOT CAUSE (2 lines max):
Address by name — exactly what happened in this test. Be specific.

📚 READING SEQUENCE (numbered — student must understand WHY each step is in this order):
1. TONIGHT (Day 1): [Exact task] | [Exact book + chapter + section] | WHY FIRST: [one line]
2. DAY 2: [Exact task] | [Exact resource] | WHY NOW: [builds on Day 1 because...]
3. DAY 3-4: [Exact task] | [Exact resource] | WHY NOW: [reason]
4. DAY 5 MINI TEST: Redo exactly Q[numbers] — timed. Pass criteria: X/Y correct.
5. DAY 6-7: [Consolidation task] | [Resource] | WHAT TO MEASURE: [specific outcome]

⚡ ONE THING TO STOP:
[The single biggest mistake — specific, not generic]

✅ SUCCESS SIGNAL:
[Exactly how student will know this week worked — measurable]
`;

        const prompt = `
Student: ${studentName}
Score: ${perf.neetMarks ?? perf.score ?? 0} / ${perf.maxMarks ?? 240} | Correct: ${perf.totalCorrect ?? 0} | Wrong: ${perf.totalWrong ?? 0} | Unattempted: ${unattemptedCount}

=== STUDENT LEVEL (pre-computed — do not override) ===
Level: ${studentLevel} | Mode: ${studentMode}
Why: ${levelRationale}
Tone directive: ${levelToneInstructions}

${priorityBlock}

=== ALL INCORRECT QUESTIONS (full metadata) ===
${JSON.stringify(incorrectQuestions, null, 2)}

${langBlock}

${mode2HinglishStructure}

Generate the complete diagnostic report and 7-day homework plan per schema.
IMPORTANT: Use the exact book references from the Priority Attack List for each chapter's "resource" field.
tonightHomework = Priority Chapter #1. day2Task = follow-up same or #2. day3_4Task = Priority #2 or #3. day5MiniTest = redo exact wrong Qs. day6_7Consolidation = Priority #3 or #4.
`;

        const tailoredInstructions = buildSubjectSpecificInstructions(incorrectQuestions, studentMode);

        // ── 5. SCHEMA — 5-slot homework plan ────────────────────────────────
        const homeworkSlotSchema = {
            type: Type.OBJECT,
            properties: {
                chapter:         { type: Type.STRING, description: "Exact chapter name being addressed in this slot." },
                subject:         { type: Type.STRING, description: "Subject: Physics, Chemistry, Botany, or Zoology." },
                taskType:        { type: Type.STRING, description: "Exactly one of: 'NCERT Active Recall', 'Formula Derivation', 'Mechanism Flowchart', 'Numerical Drill', 'Speed Test', 'Trap-Spotting', 'Concept Re-read'." },
                resource:        { type: Type.STRING, description: "The EXACT book reference from the Priority Attack List for this chapter. Biology: 'NCERT Class XI/XII Biology, Chapter X, Section Y'. Physics: 'Formula Set: [equations] | HC Verma Ch X + DC Pandey Ch Y'. Chemistry Organic: 'NCERT Ch X + MS Chouhan'. Chemistry Physical: 'NCERT Ch X + N Avasthi'. Chemistry Inorganic: 'NCERT Ch X + VK Jaiswal'. DO NOT invent references not in the priority list." },
                taskInHinglish:  { type: Type.STRING, description: "Rahul Sir's homework instruction. MUST: (1) Name the specific Q number and sub-concept that was wrong, (2) Give the exact book+section to use, (3) Describe exactly what to do (read, derive, draw, solve X problems in Y minutes), (4) End with ONE motivational line connecting to NEET. 3-5 sentences MAX." },
                durationMinutes: { type: Type.INTEGER, description: "Realistic time in minutes (20-90)." },
                selfCheck:       { type: Type.STRING, description: "Specific self-test WITHOUT notes. Biology: 'Close NCERT, write 5-line summary of [topic] from memory'. Physics: 'Solve [specific type] problem without formula sheet in under 3 minutes'. Chemistry: 'Write the mechanism of [reaction] from memory'." },
                mentorNote:      { type: Type.STRING, description: "One short Rahul Sir line — warm, honest, connects this chapter to their NEET score." }
            },
            required: ["chapter", "subject", "taskType", "resource", "taskInHinglish", "durationMinutes", "selfCheck", "mentorNote"]
        };

        const reportText = await geminiQueue.add(async () => {
            const response = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: prompt,
                config: {
                    systemInstruction: tailoredInstructions,
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: Type.OBJECT,
                        properties: {
                            studentLevel:    { type: Type.STRING, description: "Exactly one of: 'Foundation', 'Application', 'Refinement'." },
                            levelRationale:  { type: Type.STRING, description: "One sentence grounded in actual test data." },
                            academicSummary: { type: Type.STRING, description: "2-sentence summary in Rahul Sir's voice. Address by name. State the single biggest bottleneck and immediate path forward." },
                            errorAnalysis: {
                                type: Type.OBJECT,
                                properties: {
                                    conceptualCount:  { type: Type.INTEGER },
                                    applicationCount: { type: Type.INTEGER },
                                    behavioralCount:  { type: Type.INTEGER },
                                    forensicDeepDive: { type: Type.STRING, description: "Chapter-by-chapter breakdown in Rahul Sir's voice — name specific sub-concepts and Q numbers that were wrong and exactly why." }
                                },
                                required: ["conceptualCount", "applicationCount", "behavioralCount", "forensicDeepDive"]
                            },
                            actionPlan: {
                                type: Type.OBJECT,
                                properties: {
                                    tonightHomework:     { ...homeworkSlotSchema },
                                    day2Task:            { ...homeworkSlotSchema },
                                    day3_4Task:          { ...homeworkSlotSchema },
                                    day5MiniTest: {
                                        type: Type.OBJECT,
                                        properties: {
                                            instructions:    { type: Type.STRING, description: "Rahul Sir tells student to redo the exact wrong Qs from this paper under timed conditions. Name specific Q numbers, set a time limit, explain what to do differently this time." },
                                            passCriteria:    { type: Type.STRING, description: "What 'pass' means — e.g., '4 out of 5 correct means fixed. Less = one more revision loop.'" },
                                            durationMinutes: { type: Type.INTEGER }
                                        },
                                        required: ["instructions", "passCriteria", "durationMinutes"]
                                    },
                                    day6_7Consolidation: { ...homeworkSlotSchema }
                                },
                                required: ["tonightHomework", "day2Task", "day3_4Task", "day5MiniTest", "day6_7Consolidation"]
                            },
                            parentCheckpoint: { type: Type.STRING, description: "ONE non-technical question a parent can ask tonight to verify homework was done. Understandable by a non-science parent. In Hinglish or English per mode." },
                            parentBriefing:   { type: Type.STRING, description: "Warm but specific note for parents — what happened in this test, what the student does this week, exactly ONE actionable thing parents can do to support." }
                        },
                        required: ["studentLevel", "levelRationale", "academicSummary", "errorAnalysis", "actionPlan", "parentCheckpoint", "parentBriefing"]
                    }
                }
            });
            return response.text;
        });

        const report = JSON.parse(reportText);
        return res.json(report);

    } catch (error) {
        console.error("Prescription generation failure:", error);
        return res.status(500).json({ error: 'Could not generate blueprint due to parsing or API anomaly.' });
    }
});

// Fallback to indexx.html for SPA routing (if needed)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'indexx.html'));
});

app.listen(PORT, () => {
    console.log(`BioRivet Server is running on http://localhost:${PORT}`);
});
