require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(express.json());

const { 
    GROQ_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, 
    PAGE_ACCESS_TOKEN, VERIFY_TOKEN, APPS_SCRIPT_URL 
} = process.env;

const CONTACT_JSON_PATH = path.join(__dirname, "ContactData.json");
const GRATING_JSON_PATH = path.join(__dirname, "Grating.json");

function readLocalJSON(filePath) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) { return null; }
    return null;
}

// --- AI ENGINE: Multi-Model with JSON Extraction ---
async function getAIResponse(userMsg) {
    const systemPrompt = `You are a Quantum Method Assistant. 
    Analyze the message and return ONLY a JSON object:
    {
      "intent": "info_sharing" | "qna" | "greeting" | "problem_desc",
      "extracted_data": {"name": null, "phone": null, "location": null},
      "answer": "Your Bengali response"
    }
    Rules: 
    1. If user gives name/phone/location, intent is "info_sharing".
    2. If user describes a problem, intent is "problem_desc".
    3. If unknown question, set answer to "UNKNOWN".`;

    const models = ["gemini-1.5-flash", "gemini-2.0-flash"]; // Primary models

    for (const model of models) {
        try {
            const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
                contents: [{ parts: [{ text: `${systemPrompt}\n\nUser: ${userMsg}` }] }]
            });
            const rawText = res.data.candidates[0].content.parts[0].text;
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (jsonMatch) return JSON.parse(jsonMatch[0]);
        } catch (e) { console.error(`${model} failed...`); }
    }
    return { intent: "qna", answer: "দুঃখিত, এআই সার্ভার কাজ করছে না।" };
}

// --- Webhook processing ---
app.post("/webhook", async (req, res) => {
    res.status(200).send("EVENT_RECEIVED");
    const event = req.body.entry?.[0]?.messaging?.[0];
    const senderId = event?.sender?.id;
    const userMsg = event?.message?.text;

    if (!userMsg || !senderId) return;

    // ১. কাস্টম গ্রিটিং চেক (Grating.json)
    const greetings = readLocalJSON(GRATING_JSON_PATH);
    const matched = greetings?.find(g => 
        userMsg.toLowerCase().includes(g.englishGreeting?.toLowerCase()) || 
        userMsg.includes(g.banglaGreeting)
    );

    if (matched) {
        return await sendFBMessage(senderId, `${matched.banglaReply}\n\nWelcome! I am your Quantum Method Assistant. Please share your full name, phone number, and location.`);
    }

    // ২. AI এনালাইসিস
    const ai = await getAIResponse(userMsg);

    // ৩. ডাটা কালেকশন লজিক
    if (ai.intent === "info_sharing") {
        const { name, phone, location } = ai.extracted_data;

        // ভ্যালিডেশন: নাম বা ফোন না থাকলে সতর্কবার্তা
        if (!name || !phone || name === "null" || phone === "null") {
            return await sendFBMessage(senderId, "আপনার পূর্ণ নাম এবং ফোন নম্বর না দিলে আমাদের প্রতিনিধি যোগাযোগ করতে পারবে না। অনুগ্রহ করে সঠিক তথ্য দিন।");
        }

        // গুগল শিটে ডাটা পাঠানো (Apps Script-এ শুধুমাত্র entry)
        await axios.post(APPS_SCRIPT_URL, {
            action: "appendRow",
            sheetName: "Sheet1",
            rowData: [name, phone, location, ""]
        });

        // অফিস লোকেশন খোঁজা (ContactData.json)
        const contactData = readLocalJSON(CONTACT_JSON_PATH);
        const office = contactData?.find(o => location && (o.address.includes(location) || o.city.includes(location)));
        
        let officeMsg = office ? `নিকটস্থ অফিস: ${office.name}\nঠিকানা: ${office.address}\nফোন: ${office.phone1}` : "আপনার লোকেশনে কোনো অফিস পাওয়া যায়নি।";
        return await sendFBMessage(senderId, `${officeMsg}\n\nএবার আপনার সমস্যার কথা সংক্ষেপে লিখুন।`);
    }

    // ৪. প্রবলেম ডেসক্রিপশন আপডেট বা সাধারণ প্রশ্নোত্তর
    if (ai.answer === "UNKNOWN") {
        await axios.post(APPS_SCRIPT_URL, {
            action: "appendRow",
            sheetName: "UnknownQuestions",
            rowData: [new Date().toLocaleString(), userMsg]
        });
        await sendFBMessage(senderId, "দুঃখিত, আমি এই উত্তরটি জানি না। এটি রেকর্ড করা হয়েছে।");
    } else {
        await sendFBMessage(senderId, ai.answer);
    }
});

// --- Facebook API Helpers ---
async function sendFBMessage(id, text) {
    try {
        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id },
            message: { text }
        });
    } catch (e) { console.error("Send Error"); }
}

app.get("/webhook", (req, res) => {
    if (req.query["hub.verify_token"] === VERIFY_TOKEN) res.send(req.query["hub.challenge"]);
    else res.sendStatus(403);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot is live on port ${PORT}`));